import type { DB } from '@altis/db';
import { addDays, localDate, t, type ItemStatus, type MessageKey } from '@altis/shared';
import { REPORT_EXPORT_CURSOR_MAX } from '@altis/shared/api/reports';
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AccredSettings } from '../../settings/accreditation.js';
import { reportFieldErrors } from '../runs/service.js';
import type { ItemStockFacts, RecordStockFacts } from '../stock/index.js';
import { liveAt } from '../stock/index.js';
import type { ReportCtx, ReportRow } from '../types.js';

// What the collection reports share: the day a report reads the stock at, its cursors, its labels, and the rules of
// the stock written twice, once as SQL over the current rows (today's answers, from grouped queries) and once over the
// facts of the stock scan (any other day). The two forms must agree on today: a copy is in the stock when it is not
// withdrawn, not on order, not lost, and acquired by the day (or undated); a title is in the stock when it is not
// archived and has such a copy, or, without any copy at all, is electronic or has a public file.
//
// Today's form reads the status of the current row, which is the status of the last history entry, and treats a
// receiving date (or, without one, the date entered in the source system) after the day as not yet acquired.

/** Below this much budget a scan stops for the slice and answers its cursor. */
export const SCAN_MARGIN_MS = 2_000;

/** The statuses a copy in the stock can have (on order, lost and withdrawn copies are not in it). */
export const STOCK_STATUSES: readonly ItemStatus[] = Object.freeze(['processing', 'available', 'not_for_loan', 'repair', 'missing']);

/** Who made a title that counts as a local work of the school. */
export const SCHOOL_LOCAL_WORKS: readonly string[] = Object.freeze(['student', 'teacher', 'staff', 'school']);

/** The group key of a value that is not set (a title without copies, a record without a language). */
export const GROUP_NONE = '-';

// ---- the day ------------------------------------------------------------------------------------------------------

/**
 * The day a stock report reads, and whether it needs the scan: `asOf` when it is set and is not today (scan), else today
 * (the current rows).
 */
export function stockDay(ctx: ReportCtx): { day: string; scan: boolean } {
  const asOf = ctx.params['asOf'];
  if (typeof asOf !== 'string' || asOf === ctx.today) return { day: ctx.today, scan: false };
  return { day: asOf, scan: true };
}

/** A string parameter, or null. */
export function textParam(ctx: ReportCtx, name: string): string | null {
  const value = ctx.params[name];
  return typeof value === 'string' ? value : null;
}

/** A `dateRange` parameter. */
export function rangeParam(ctx: ReportCtx, name: string): { from: string | null; to: string | null } {
  const value = ctx.params[name] as { from?: string; to?: string } | undefined;
  return { from: value?.from ?? null, to: value?.to ?? null };
}

/** The first instant whose local date in `tz` is `date` (or later). */
export function localDayStart(tz: string, date: string): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  // Every zone is within 15 hours of UTC: search that window for the first instant of the local day.
  let lo = midnight - 15 * 3_600_000;
  let hi = midnight + 15 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDate(tz, mid) >= date) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The instants `[from, to)` of a local date range (either bound open). */
export function instantRange(tz: string, range: { from: string | null; to: string | null }): { from: number | null; to: number | null } {
  return {
    from: range.from === null ? null : localDayStart(tz, range.from),
    to: range.to === null ? null : localDayStart(tz, addDays(range.to, 1)),
  };
}

// ---- cursors ------------------------------------------------------------------------------------------------------

/**
 * `value` as a cursor (JSON).
 *
 * @throws Error when it would be longer than an export's cursor may be (a scan whose running totals grew too large)
 */
export function encodeCursor(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length > REPORT_EXPORT_CURSOR_MAX) throw new Error(`collection report: a cursor of ${text.length} characters is over ${REPORT_EXPORT_CURSOR_MAX}`);
  return text;
}

/**
 * The value of a cursor this report answered.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'cursor', code: 'invalid'}` for anything else
 */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw reportFieldErrors([{ path: 'cursor', code: 'invalid' }]);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw reportFieldErrors([{ path: 'cursor', code: 'invalid' }]);
  return parsed.data;
}

/** The page of `rows` (an aggregate computed whole) from `cursor` (its offset), `limit` rows long. */
export function offsetPage(rows: readonly ReportRow[], cursor: string | null, limit: number): { rows: ReportRow[]; nextCursor: string | null } {
  const from = cursor === null ? 0 : decodeCursor(cursor, z.strictObject({ o: z.int().min(0).max(Number.MAX_SAFE_INTEGER) })).o;
  const to = from + limit;
  return { rows: rows.slice(from, to), nextCursor: to < rows.length ? encodeCursor({ o: to }) : null };
}

// ---- labels and cells ---------------------------------------------------------------------------------------------

/** A shared text in the report's language. */
export function label(ctx: ReportCtx, key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return t(ctx.locale, key, params);
}

/** The label of a vocabulary value (`vocab.<list>.<value>`), or null for no value. */
export function vocabLabel(ctx: ReportCtx, list: string, value: string | null): string | null {
  return value === null ? null : t(ctx.locale, `vocab.${list}.${value}` as MessageKey);
}

/** The name of a master row in the report's language. */
export function masterName(ctx: ReportCtx, row: { name_id: string; name_en: string }): string {
  return ctx.locale === 'en' ? row.name_en : row.name_id;
}

/** A price in minor units as a money cell (major units). */
export function moneyCell(minor: number | string | null): number | null {
  return minor === null ? null : Number(minor) / 100;
}

/** A title with its subtitle (`Judul : anak judul`). */
export function titleCell(r: { title: string; subtitle: string | null }): string {
  return r.subtitle === null || r.subtitle.trim() === '' ? r.title : `${r.title} : ${r.subtitle}`;
}

/** A nonempty text, or null. */
export function textCell(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === '' ? null : value;
}

// ---- the stock rules over the scan's facts ------------------------------------------------------------------------

/** What a stock report may restrict the copies to (besides the branch the scan already keeps to). */
export interface ItemScope {
  branchId: string | null;
  locationId?: string | null;
  collectionTypeId?: string | null;
}

/** True when the scope restricts the copies at all (titles without copies are then out). */
export function scopesItems(s: ItemScope): boolean {
  return s.branchId !== null || (s.locationId ?? null) !== null || (s.collectionTypeId ?? null) !== null;
}

/** True when copy `i` is in `s` (the branch is the scan's). */
export function inScope(i: ItemStockFacts, s: ItemScope): boolean {
  const location = s.locationId ?? null;
  const type = s.collectionTypeId ?? null;
  return (location === null || i.locationId === location) && (type === null || i.collectionTypeId === type);
}

/**
 * The copies of title `r` in the stock on `day` within `s`, or null when the title is not in the stock there. A title
 * without any copy counts (with no copies) only when the scope does not restrict copies.
 */
export function stockCopies(r: RecordStockFacts, day: string, electronic: ReadonlySet<string>, s: ItemScope): ItemStockFacts[] | null {
  if (r.archived) return null;
  if (r.items.length === 0) {
    if (scopesItems(s)) return null;
    const counted = (r.materialTypeCode !== null && electronic.has(r.materialTypeCode)) || r.hasPublicFile;
    return counted && (r.createdOn === null || r.createdOn <= day) ? [] : null;
  }
  const live = r.items.filter((i) => liveAt(i, day) && inScope(i, s));
  return live.length > 0 ? live : null;
}

/** `value` trimmed and upper-cased starts with one of `prefixes` (upper case). */
function startsWithAny(value: string | null, prefixes: readonly string[]): boolean {
  if (value === null || prefixes.length === 0) return false;
  const v = value.trim().toUpperCase();
  return prefixes.some((p) => v.startsWith(p));
}

/** The fiction rule's prefixes, trimmed and upper-cased. */
function fictionPrefixes(f: AccredSettings['fiction']): { callNumber: string[]; ddc: string[] } {
  return { callNumber: f.callNumberPrefixes.map((p) => p.trim().toUpperCase()), ddc: f.ddcPrefixes.map((p) => p.trim().toUpperCase()) };
}

/**
 * True when title `r` is fiction on `day`: a live copy of a fiction collection type, a call number (the record's or a
 * live copy's) with a fiction prefix, or a classification with a fiction prefix.
 */
export function isFiction(r: RecordStockFacts, day: string, settings: AccredSettings): boolean {
  const codes = new Set(settings.fiction.collectionTypeCodes);
  const p = fictionPrefixes(settings.fiction);
  if (startsWithAny(r.callNumber, p.callNumber) || startsWithAny(r.classification, p.ddc)) return true;
  return r.items.some((i) => liveAt(i, day) && ((i.collectionTypeCode !== null && codes.has(i.collectionTypeCode)) || startsWithAny(i.callNumber, p.callNumber)));
}

/** True when title `r` is reference on `day`: a live copy of a reference collection type. */
export function isReference(r: RecordStockFacts, day: string, settings: AccredSettings): boolean {
  const codes = new Set(settings.referenceCollectionTypeCodes);
  return r.items.some((i) => liveAt(i, day) && i.collectionTypeCode !== null && codes.has(i.collectionTypeCode));
}

// ---- the stock rules as SQL over the current rows -----------------------------------------------------------------

const ref = (alias: string, column: string) => sql.ref(`${alias}.${column}`);

/** One condition of all of `parts` (true for none). */
export function allOf(parts: readonly RawBuilder<SqlBool>[]): RawBuilder<SqlBool> {
  return parts.length === 0 ? sql<SqlBool>`1 = 1` : sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

/** One condition of any of `parts` (false for none). */
export function anyOf(parts: readonly RawBuilder<SqlBool>[]): RawBuilder<SqlBool> {
  return parts.length === 0 ? sql<SqlBool>`1 = 0` : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

/** `s` with the LIKE wildcards (and the escape character `!`) escaped for `LIKE … ESCAPE '!'`. */
function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/** The column, trimmed and upper-cased, starts with one of `prefixes` (upper case). */
export function prefixSql(column: RawBuilder<unknown> | ReturnType<typeof sql.ref>, prefixes: readonly string[]): RawBuilder<SqlBool> {
  return anyOf(prefixes.map((p) => sql<SqlBool>`upper(trim(${column})) like ${`${escapeLike(p)}%`} escape '!'`));
}

/** Copy `i` (a table alias) is in the stock on `day`. */
export function liveItemSql(i: string, day: string): RawBuilder<SqlBool> {
  const received = ref(i, 'received_date');
  return sql<SqlBool>`(${ref(i, 'archived_at')} is null and ${ref(i, 'status')} not in ('on_order', 'lost') and (${received} is null or ${received} <= ${day}) and (${received} is not null or ${ref(i, 'input_on')} is null or ${ref(i, 'input_on')} <= ${day}))`;
}

/** Copy `i` is in scope `s` (branch, location, collection type). */
export function itemScopeSql(i: string, s: ItemScope): RawBuilder<SqlBool> {
  const parts: RawBuilder<SqlBool>[] = [];
  if (s.branchId !== null) parts.push(sql<SqlBool>`${ref(i, 'branch_id')} = ${s.branchId}`);
  if ((s.locationId ?? null) !== null) parts.push(sql<SqlBool>`${ref(i, 'location_id')} = ${s.locationId}`);
  if ((s.collectionTypeId ?? null) !== null) parts.push(sql<SqlBool>`${ref(i, 'collection_type_id')} = ${s.collectionTypeId}`);
  return allOf(parts);
}

/** Title `r` has a material type of one of `codes`. */
export function materialCodeSql(r: string, codes: readonly string[]): RawBuilder<SqlBool> {
  if (codes.length === 0) return sql<SqlBool>`1 = 0`;
  return sql<SqlBool>`exists (select 1 from material_types smt where smt.id = ${ref(r, 'material_type_id')} and smt.code_key in (${sql.join(codes)}))`;
}

/** Title `r` has a copy in the stock on `day` within `s`. */
export function hasStockCopySql(r: string, day: string, s: ItemScope): RawBuilder<SqlBool> {
  return sql<SqlBool>`exists (select 1 from items si where si.record_id = ${ref(r, 'id')} and ${liveItemSql('si', day)} and ${itemScopeSql('si', s)})`;
}

/** Title `r` has no copy at all and is electronic or has a public file (it counts without copies). */
export function countedWithoutCopiesSql(r: string, electronicCodes: readonly string[]): RawBuilder<SqlBool> {
  const id = ref(r, 'id');
  return sql<SqlBool>`(not exists (select 1 from items ni where ni.record_id = ${id}) and (${materialCodeSql(r, electronicCodes)} or exists (select 1 from attachments sa where sa.record_id = ${id} and sa.kind = 'file' and sa.access = 'public' and sa.archived_at is null and sa.file_id is not null)))`;
}

/** Title `r` is in the stock on `day` within `s` (today's form of {@link stockCopies}). */
export function stockTitleSql(r: string, day: string, s: ItemScope, electronicCodes: readonly string[]): RawBuilder<SqlBool> {
  const parts = [hasStockCopySql(r, day, s)];
  if (!scopesItems(s)) parts.push(countedWithoutCopiesSql(r, electronicCodes));
  return sql<SqlBool>`(${ref(r, 'archived_at')} is null and ${anyOf(parts)})`;
}

/** Title `r` is fiction on `day` (today's form of {@link isFiction}); the copies are those of the branch, if any. */
export function fictionSql(r: string, day: string, branchId: string | null, settings: AccredSettings): RawBuilder<SqlBool> {
  const codes = settings.fiction.collectionTypeCodes;
  const p = fictionPrefixes(settings.fiction);
  const id = ref(r, 'id');
  const branch = (i: string) => itemScopeSql(i, { branchId });
  const terms: RawBuilder<SqlBool>[] = [];
  if (codes.length > 0) {
    terms.push(
      sql<SqlBool>`exists (select 1 from items fi inner join collection_types fct on fct.id = fi.collection_type_id where fi.record_id = ${id} and ${liveItemSql('fi', day)} and ${branch('fi')} and fct.code_key in (${sql.join(codes)}))`,
    );
  }
  if (p.callNumber.length > 0) {
    terms.push(prefixSql(ref(r, 'call_number'), p.callNumber));
    terms.push(sql<SqlBool>`exists (select 1 from items fc where fc.record_id = ${id} and ${liveItemSql('fc', day)} and ${branch('fc')} and ${prefixSql(sql.ref('fc.call_number'), p.callNumber)})`);
  }
  if (p.ddc.length > 0) terms.push(prefixSql(ref(r, 'classification'), p.ddc));
  return anyOf(terms);
}

/** Title `r` is reference on `day` (today's form of {@link isReference}). */
export function referenceSql(r: string, day: string, branchId: string | null, settings: AccredSettings): RawBuilder<SqlBool> {
  const codes = settings.referenceCollectionTypeCodes;
  if (codes.length === 0) return sql<SqlBool>`1 = 0`;
  return sql<SqlBool>`exists (select 1 from items ri inner join collection_types rct on rct.id = ri.collection_type_id where ri.record_id = ${ref(r, 'id')} and ${liveItemSql('ri', day)} and ${itemScopeSql('ri', { branchId })} and rct.code_key in (${sql.join(codes)}))`;
}

/** Title `r`'s classification starts with `prefix` (trimmed, any case). */
export function classPrefixSql(r: string, prefix: string): RawBuilder<SqlBool> {
  return prefixSql(ref(r, 'classification'), [prefix.trim().toUpperCase()]);
}

// ---- master rows --------------------------------------------------------------------------------------------------

/** A master row's label and its place in a list. */
export interface MasterLabel {
  label: string;
  order: readonly (string | number)[];
}

/** Compares two {@link MasterLabel} orders. */
export function compareOrder(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let k = 0; k < Math.max(a.length, b.length); k += 1) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The material types of `codes` (code keys), by code. */
export async function materialTypesByCode(ctx: ReportCtx, codes: readonly string[]): Promise<Map<string, MasterLabel>> {
  const out = new Map<string, MasterLabel>();
  if (codes.length === 0) return out;
  const rows = await ctx.db.selectFrom('material_types').select(['code_key', 'name_id', 'name_en', 'sort_order']).where('code_key', 'in', [...codes]).execute();
  for (const r of rows) out.set(r.code_key, { label: masterName(ctx, r), order: [Number(r.sort_order), masterName(ctx, r), r.code_key] });
  return out;
}

/** The collection types of `ids`, by id. */
export async function collectionTypesById(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, MasterLabel>> {
  const out = new Map<string, MasterLabel>();
  if (ids.length === 0) return out;
  const rows = await ctx.db.selectFrom('collection_types').select(['id', 'code_key', 'name_id', 'name_en', 'sort_order']).where('id', 'in', [...ids]).execute();
  for (const r of rows) out.set(r.id, { label: masterName(ctx, r), order: [Number(r.sort_order), masterName(ctx, r), r.code_key] });
  return out;
}

/** The locations of `ids`, by id. */
export async function locationsById(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, MasterLabel>> {
  const out = new Map<string, MasterLabel>();
  if (ids.length === 0) return out;
  const rows = await ctx.db.selectFrom('locations').select(['id', 'code_key', 'name', 'sort_order']).where('id', 'in', [...ids]).execute();
  for (const r of rows) out.set(r.id, { label: r.name, order: [Number(r.sort_order), r.name, r.code_key] });
  return out;
}

/** The languages of `ids`, by id. */
export async function languagesById(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, MasterLabel>> {
  const out = new Map<string, MasterLabel>();
  if (ids.length === 0) return out;
  const rows = await ctx.db.selectFrom('languages').select(['id', 'code_key', 'name_id', 'name_en']).where('id', 'in', [...ids]).execute();
  for (const r of rows) out.set(r.id, { label: masterName(ctx, r), order: [masterName(ctx, r), r.code_key] });
  return out;
}

/** The code key of material type `id` (null when there is none). */
export async function materialTypeCodeOf(db: Kysely<DB>, id: string): Promise<string | null> {
  const row = await db.selectFrom('material_types').select('code_key').where('id', '=', id).executeTakeFirst();
  return row?.code_key ?? null;
}

/** Splits `ids` into chunks of at most `size` (IN lists stay short on every engine). */
export function chunks<T>(ids: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let k = 0; k < ids.length; k += size) out.push(ids.slice(k, k + size));
  return out;
}
