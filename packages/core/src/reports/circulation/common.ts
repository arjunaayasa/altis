import { addDays, localDate, type MessageKey } from '@altis/shared';
import { DDC_MAINS } from '@altis/shared';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { titleKey } from '../../catalog/lib/title-key.js';
import { nameKeyWords, normalizeMemberNo } from '../../members/keys.js';
import { reportColumn } from '../params.js';
import type { ReportColumn, ReportCtx } from '../types.js';
import { allOf, anyOf, label } from '../collection/common.js';

// What the member, visit and circulation reports share: the class and month columns of their matrices, the dates of
// a range and of every branch, and the filters typed by a person (a member's number or name, words of a title).
//
// Loans, in-library uses and visits keep the dimensions they had when they happened (`stat_*`, the member type and
// class of a visit), so the counts by class, type or group stay right after a record is edited or a member leaves.
// A voided loan (a lend undone at the desk) never happened for any count.

/** The class columns of a matrix, in order: the ten DDC main classes, 2X and the other classes. */
export const CLASS_KEYS = ['c000', 'c100', 'c200', 'c300', 'c400', 'c500', 'c600', 'c700', 'c800', 'c900', 'c2x', 'cnon'] as const;

/** The month columns of a year, January to December. */
export const MONTH_KEYS = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12'] as const;

/** The DDC main classes a matrix can open into divisions. */
export const MAIN_CLASS_OPTIONS = DDC_MAINS.filter((m) => /^\d00$/.test(m));

/** The class columns and the total, as int columns. */
export const CLASS_COLUMNS: readonly ReportColumn[] = Object.freeze([...CLASS_KEYS, 'total'].map((key) => reportColumn(key, 'int')));

/** The month columns and the total, as int columns. */
export const MONTH_COLUMNS: readonly ReportColumn[] = Object.freeze([...MONTH_KEYS, 'total'].map((key) => reportColumn(key, 'int')));

/**
 * The column of a stored class snapshot (`stat_ddc`: a division `ab0`, `2X`, or null for any other class): 0–9 for
 * a main class, 10 for 2X, 11 for the others.
 */
export function classIndexOf(stat: string | null): number {
  if (stat === null) return 11;
  if (stat.toUpperCase() === '2X') return 10;
  const digit = /^(\d)\d\d$/.exec(stat);
  return digit === null ? 11 : Number(digit[1]);
}

/** The division (0–9) of a stored class snapshot within main class `main` (`800`), or null when it is not in it. */
export function divisionIndexOf(stat: string | null, main: string): number | null {
  if (stat === null) return null;
  const m = /^(\d)(\d)\d$/.exec(stat);
  if (m === null || m[1] !== main[0]) return null;
  return Number(m[2]);
}

/** The label of division `k` of main class `main`: `810–819`. */
export function divisionLabel(main: string, k: number): string {
  const from = `${main[0]}${k}0`;
  return `${from}–${main[0]}${k}9`;
}

/** The month index (0–11) of a `YYYY-MM…` text, or null. */
export function monthIndexOf(month: string | number | null): number | null {
  if (month === null) return null;
  const m = /^\d{4}-(\d{2})/.exec(String(month));
  if (m === null) return null;
  const k = Number(m[1]) - 1;
  return k >= 0 && k < 12 ? k : null;
}

/** `YYYY-MM` of month index `k` (0–11) of `year`. */
export function monthText(year: number, k: number): string {
  return `${year}-${String(k + 1).padStart(2, '0')}`;
}

/** A `year` parameter, or the year of today. */
export function yearParam(ctx: ReportCtx, name = 'year'): number {
  const value = ctx.params[name];
  return typeof value === 'number' ? value : Number(ctx.today.slice(0, 4));
}

/** An `int` parameter, or `fallback`. */
export function intParam(ctx: ReportCtx, name: string, fallback: number): number {
  const value = ctx.params[name];
  return typeof value === 'number' ? value : fallback;
}

/** A `bool` parameter. */
export function boolParam(ctx: ReportCtx, name: string): boolean {
  return ctx.params[name] === true;
}

/**
 * A date range parameter with both bounds: what was given, else `fallbackDays` days up to today (or from `from`).
 */
export function closedRange(ctx: ReportCtx, name: string, fallbackDays: number): { from: string; to: string } {
  const value = ctx.params[name] as { from?: string; to?: string } | undefined;
  const to = value?.to ?? (value?.from !== undefined && value.from > ctx.today ? value.from : ctx.today);
  const from = value?.from ?? addDays(to, -(fallbackDays - 1));
  return { from, to };
}

/** Today in each branch's own time zone (the library's for a branch without one). */
export async function branchTodays(ctx: ReportCtx): Promise<Map<string, string>> {
  const rows = await ctx.db.selectFrom('branches').select(['id', 'timezone']).execute();
  return new Map(rows.map((b) => [b.id, localDate(b.timezone || ctx.tz, ctx.now)]));
}

/** `today` of `branchId` in `todays`, else the library's. */
export function todayAt(ctx: ReportCtx, todays: ReadonlyMap<string, string>, branchId: string): string {
  return todays.get(branchId) ?? ctx.today;
}

/**
 * A loan (alias `l`) whose due date is before the day `days` days from today in its own branch: written per branch
 * (`branch = b and due_on <= bound_b`), the branches being few. `offset` -1 asks for "due before today" (overdue).
 */
export function dueBeforeSql(todays: ReadonlyMap<string, string>, offset: number, op: '<=' | '>' = '<='): RawBuilder<SqlBool> {
  const parts = [...todays.entries()].map(([branchId, today]) =>
    op === '<='
      ? sql<SqlBool>`(l.branch_id = ${branchId} and l.due_on <= ${addDays(today, offset)})`
      : sql<SqlBool>`(l.branch_id = ${branchId} and l.due_on > ${addDays(today, offset)})`,
  );
  return anyOf(parts);
}

/** `s` with the LIKE wildcards (and the escape character `!`) escaped for `LIKE … ESCAPE '!'`. */
export function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/** Members (alias `m`) whose number is `text` (spaces and case aside), or whose name holds every word of it. */
export function memberMatchSql(text: string, m = 'm'): RawBuilder<SqlBool> {
  const no = normalizeMemberNo(text);
  const words = nameKeyWords(text);
  const parts: RawBuilder<SqlBool>[] = [sql<SqlBool>`${sql.ref(`${m}.member_no_key`)} = ${no}`];
  if (words.length > 0) {
    parts.push(allOf(words.map((w) => sql<SqlBool>`${sql.ref(`${m}.name_key`)} like ${`%${escapeLike(w)}%`} escape '!'`)));
  }
  return anyOf(parts);
}

/** Records (alias `r`) whose title holds every word of `text`; null when `text` has no word. */
export function titleMatchSql(text: string, r = 'r'): RawBuilder<SqlBool> | null {
  const words = titleKey(text)
    .split(' ')
    .filter((w) => w !== '');
  if (words.length === 0) return null;
  return allOf(words.map((w) => sql<SqlBool>`${sql.ref(`${r}.title_key`)} like ${`%${escapeLike(w)}%`} escape '!'`));
}

/** The text of a member type in the report's language. */
export function typeName(ctx: ReportCtx, row: { name_id: string | null; name_en: string | null }): string | null {
  if (row.name_id === null) return null;
  return ctx.locale === 'en' ? (row.name_en ?? row.name_id) : row.name_id;
}

/** A row label of these reports (`report.row.circ.<key>`). */
export function rowLabel(ctx: ReportCtx, key: string, params?: Readonly<Record<string, string | number>>): string {
  return label(ctx, `report.row.circ.${key}` as MessageKey, params);
}

/** A section label of these reports (`report.section.circ.<key>`). */
export function sectionLabel(ctx: ReportCtx, key: string): string {
  return label(ctx, `report.section.circ.${key}` as MessageKey);
}

/** The local time `HH:MM` of `at` in `tz`, with its date: `2026-03-02 10:15`. */
export function localDateTime(tz: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${localDate(tz, at)} ${parts}`;
}

/** The cursor of a keyset over (text, id). */
export const textIdKeyset = z.tuple([z.string().max(400), z.string().min(1).max(26)]);

/** The cursor of a keyset over (number, id). */
export const numberIdKeyset = z.tuple([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(26)]);

/** Sums a row of numbers. */
export function sumOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
