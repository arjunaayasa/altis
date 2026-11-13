import { ddcClassOf, isCalendarDate } from '@altis/shared';
import { textCell } from '../../migration/slims/source/clean-text.js';
import type { SlimsRow } from '../../migration/slims/source/types.js';
import type { DateSpan } from '../windows.js';

// The counting rules of the SLiMS usage import (spec §11.2), row by row and month by month, without any file or
// database: the import's job feeds them the rows it reads and keeps what they return in its work files. SLiMS 9
// table/column names (interoperability facts, no SLiMS code). Every member id reaching here is already its keyed hash
// (32 hex characters; '' or NULL for a guest).
//
// - A date is the first 10 characters of the cell; it counts when it is a calendar date other than 1970-01-01 (NULL,
//   a zero date and the epoch's day are `date_invalid`), and before the cut-over day (`after_cutover` otherwise). Its
//   month is its first 7 characters (the server's local time, no zone conversion).
// - The row group of a member id: '' or NULL → `guest`; a member with a type → `slims_type:<type id>`; any other id
//   (no `member` row any more, or one without a type) → `member_unknown`.
// - Loans: `loan` then `loan_history`; a `loan_id` met before is skipped (a renewal is no new row in SLiMS, and a
//   history row repeats its loan). Per month: by group, in total (''), and by class `ddc:<0…9|2X|NON>` from the
//   classification of the title the copy leads to, else (a history row) the history row's own classification.
// - Visits: every counted `visitor_count` row; a guest's visit counts at once (raw and deduplicated); a member's
//   check-in goes to its month's work file, which the aggregate step reads in calendar order: a check-in is a repeat when
//   the same member's previous check-in, kept or not, lies less than the repeat window before it, across month ends
//   too (the previous month's last check-in is carried in when it lies within the window of that month's end).
// - Span metrics for the three period spans: copies and titles used (loans and in-library use), distinct borrowers and
//   visitors by group, and members whose membership runs to the span's end at least, by type.

/** The tables the import reads, as its phases name them. */
export type UsageTable = 'mst_member_type' | 'member' | 'biblio' | 'item' | 'loan' | 'loan_history' | 'visitor_count' | 'read_counter';

/** The dated tables, whose dropped rows are tallied. */
export type DatedTable = 'loan' | 'loan_history' | 'visitor_count' | 'read_counter';

/** metric → row group → count. */
export type UsageCells = Record<string, Record<string, number>>;

/** What the counting adds up as it goes (kept in the import's state between slices). */
export interface UsageCounts {
  /** The rows read per table. */
  rows: Record<string, number>;
  /** Rows dropped for an empty, zero or invalid date, per table. */
  dateInvalid: Record<string, number>;
  /** Rows dropped for a date on or after the cut-over day, per table. */
  afterCutover: Record<string, number>;
  /** Loan rows skipped because their `loan_id` was met before. */
  loanSeenBefore: number;
  /** Counted loans and visits of ids SLiMS no longer has as typed members. */
  memberUnknown: { loans: number; visits: number };
  /** Per month `YYYY-MM`: metric → row group → count. */
  monthly: Record<string, UsageCells>;
}

/** What the import keeps of one member: its type id (null without a usable one) and the day its membership ends. */
export interface MemberInfo {
  type: string | null;
  expire: string | null;
}

/** A member's loan or check-in in its month: the member's hash and the second of the month. */
export interface MonthEntry {
  hash: string;
  second: number;
}

/** An empty set of counts. */
export function emptyCounts(): UsageCounts {
  return { rows: {}, dateInvalid: {}, afterCutover: {}, loanSeenBefore: 0, memberUnknown: { loans: 0, visits: 0 }, monthly: {} };
}

const DAY_SECONDS = 86_400;
const EPOCH_DAY = '1970-01-01';
/** A SLiMS member type id usable in a row group key (`slims_type:<id>`). */
const TYPE_ID = /^[0-9A-Za-z_-]{1,36}$/;
/** A member id as the readers hash it. */
const HASH = /^[0-9a-f]{32}$/;

/** A cell as text: bytes as UTF-8 when they are, else Latin-1; null for NULL. */
export function cellText(cell: SlimsRow[string] | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  const decoded = textCell(cell);
  return typeof decoded === 'string' ? decoded : Buffer.from(decoded).toString('latin1');
}

/** The counted date of a cell (see the top of this file), or null. */
export function dateOfCell(cell: SlimsRow[string] | undefined): string | null {
  const value = cellText(cell);
  if (value === null) return null;
  const date = value.slice(0, 10);
  return isCalendarDate(date) && date !== EPOCH_DAY ? date : null;
}

/** The member type id of a cell when it can name a row group, else null. */
export function typeIdOfCell(cell: SlimsRow[string] | undefined): string | null {
  const value = cellText(cell)?.trim() ?? null;
  return value !== null && TYPE_ID.test(value) ? value : null;
}

/**
 * The member hash of a cell as the readers leave it: '' for a guest (an empty or NULL id), else the hash.
 *
 * @throws TypeError for anything the readers never produce (a raw id would be one)
 */
export function hashOfCell(cell: SlimsRow[string] | undefined): string {
  if (cell === null || cell === undefined || cell === '') return '';
  if (typeof cell === 'string' && HASH.test(cell)) return cell;
  throw new TypeError('a member id that is not its keyed hash reached the usage counts');
}

/** The row group of member hash `hash` (see the top of this file). */
export function groupOfHash(hash: string, members: ReadonlyMap<string, MemberInfo>): string {
  if (hash === '') return 'guest';
  const member = members.get(hash);
  return member === undefined || member.type === null ? 'member_unknown' : `slims_type:${member.type}`;
}

/** `ddc:<0…9|2X|NON>` of a classification text. */
export function ddcGroupKey(classification: string | null): string {
  const main = ddcClassOf(classification, null).main;
  return `ddc:${/^\d00$/.test(main) ? main.slice(0, 1) : main}`;
}

/** The seconds of month `YYYY-MM`. */
export function monthSeconds(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate() * DAY_SECONDS;
}

/** The month after `YYYY-MM`. */
export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${String(y + 1).padStart(4, '0')}-01` : `${month.slice(0, 4)}-${String(m + 1).padStart(2, '0')}`;
}

/** The part of a time `HH:MM:SS` from character `at`, as a number from 0 to `max` (a missing or broken part is 0). */
function timePart(value: string, at: number, max: number): number {
  const n = Number(value.slice(at, at + 2));
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : 0;
}

/** The second of its month of a SLiMS date or date-time text whose first 10 characters are a calendar date. */
export function secondOfMonth(value: string): number {
  const day = Number(value.slice(8, 10));
  return (day - 1) * DAY_SECONDS + timePart(value, 11, 23) * 3600 + timePart(value, 14, 59) * 60 + timePart(value, 17, 59);
}

/** The calendar date of the second `second` of month `YYYY-MM`. */
export function dateOfSecond(month: string, second: number): string {
  return `${month}-${String(Math.floor(second / DAY_SECONDS) + 1).padStart(2, '0')}`;
}

/** Adds `n` to cell (metric, group) of `cells`. */
export function addCell(cells: UsageCells, metric: string, group: string, n = 1): void {
  const m = (cells[metric] ??= {});
  m[group] = (m[group] ?? 0) + n;
}

/** The cells of month `month` of `counts`, created on first use. */
export function monthCells(counts: UsageCounts, month: string): UsageCells {
  return (counts.monthly[month] ??= {});
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

/**
 * The counted date of `cell` in `table` (see the top of this file), tallying a dropped row.
 *
 * @returns null for a dropped row
 */
export function takeDate(counts: UsageCounts, table: DatedTable, cell: SlimsRow[string] | undefined, cutoverOn: string | null): string | null {
  const date = dateOfCell(cell);
  if (date === null) {
    bump(counts.dateInvalid, table);
    return null;
  }
  if (cutoverOn !== null && date >= cutoverOn) {
    bump(counts.afterCutover, table);
    return null;
  }
  return date;
}

/** The indexes of the spans holding `date`. */
export function spansOf(spans: readonly DateSpan[], date: string): number[] {
  const out: number[] = [];
  spans.forEach((s, i) => {
    if (s.from <= date && date <= s.to) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows

/** What the row rules read and where they put what they find besides the counts. */
export interface RowContext {
  counts: UsageCounts;
  cutoverOn: string | null;
  spans: readonly DateSpan[];
  members: ReadonlyMap<string, MemberInfo>;
  /** Copy (item code) → title (biblio id); the first row of a code wins. */
  items: ReadonlyMap<string, string>;
  /** Title → `ddc:<class>` of its own classification, '' when it has none. */
  titles: ReadonlyMap<string, string>;
  /** The loan ids met so far. */
  seenLoans: ReadonlySet<string>;
  /** Member type id → name. */
  types: Record<string, string>;
  addMember(hash: string, info: MemberInfo): void;
  addItem(code: string, titleId: string): void;
  addTitle(titleId: string, ddcKey: string): void;
  addLoanId(loanId: string): void;
  /** A member's loan or check-in of `month`, for the aggregate step. */
  entry(kind: 'visits' | 'borrows', month: string, e: MonthEntry): void;
  /** A copy (non-empty code) and a title used in span `span`. */
  used(span: number, itemCode: string | null, titleId: string | null): void;
}

/** The longest member type name kept (the width of the group map's label). */
const LABEL_MAX = 191;

/** A `mst_member_type` row: the type's name (the first row of an id wins). */
export function countMemberType(c: RowContext, row: SlimsRow): void {
  const id = typeIdOfCell(row['member_type_id']);
  if (id === null || Object.hasOwn(c.types, id)) return;
  c.types[id] = Array.from(cellText(row['member_type_name']) ?? '').slice(0, LABEL_MAX).join('');
}

/** A `member` row: its type and the day its membership ends (the first row of a member wins). */
export function countMember(c: RowContext, row: SlimsRow): void {
  const hash = hashOfCell(row['member_id']);
  if (hash === '' || c.members.has(hash)) return;
  c.addMember(hash, { type: typeIdOfCell(row['member_type_id']), expire: dateOfCell(row['expire_date']) });
}

/** A `biblio` row: the class of its own classification (the last row of an id wins). */
export function countTitle(c: RowContext, row: SlimsRow): void {
  const id = cellText(row['biblio_id']);
  if (id === null) return;
  const classification = cellText(row['classification']);
  c.addTitle(id, classification !== null && classification.trim() !== '' ? ddcGroupKey(classification) : '');
}

/** An `item` row: the title of its code (the first row of a code wins). */
export function countItem(c: RowContext, row: SlimsRow): void {
  const code = cellText(row['item_code']);
  const titleId = cellText(row['biblio_id']);
  if (code === null || titleId === null || c.items.has(code)) return;
  c.addItem(code, titleId);
}

/** The copy and title a loan or a read used, in every span holding `date`. */
function countUse(c: RowContext, date: string, code: string | null, historyTitle: string | null): void {
  const copy = code !== null && code !== '' ? code : null;
  const titleId = copy !== null && c.items.has(copy) ? c.items.get(copy)! : historyTitle;
  for (const span of spansOf(c.spans, date)) c.used(span, copy, titleId);
}

/** A `loan` or `loan_history` row. */
export function countLoan(c: RowContext, table: 'loan' | 'loan_history', row: SlimsRow): void {
  const loanId = cellText(row['loan_id']) ?? 'null';
  if (c.seenLoans.has(loanId)) {
    c.counts.loanSeenBefore += 1;
    return;
  }
  c.addLoanId(loanId);
  const date = takeDate(c.counts, table, row['loan_date'], c.cutoverOn);
  if (date === null) return;
  const hash = hashOfCell(row['member_id']);
  const group = groupOfHash(hash, c.members);
  const month = date.slice(0, 7);
  const cells = monthCells(c.counts, month);
  addCell(cells, 'loans', group);
  addCell(cells, 'loans', '');
  const code = cellText(row['item_code']);
  const titleId = code === null ? undefined : c.items.get(code);
  const own = titleId === undefined ? '' : (c.titles.get(titleId) ?? '');
  const history = table === 'loan_history' ? cellText(row['classification']) : null;
  addCell(cells, 'loans', own !== '' ? own : ddcGroupKey(history));
  if (group === 'member_unknown') c.counts.memberUnknown.loans += 1;
  if (group !== 'guest') c.entry('borrows', month, { hash, second: secondOfMonth(cellText(row['loan_date'])!) });
  countUse(c, date, code, table === 'loan_history' ? cellText(row['biblio_id']) : null);
}

/** A `visitor_count` row: a guest's visit counts now, a member's check-in waits for the aggregate step. */
export function countVisit(c: RowContext, row: SlimsRow): void {
  const date = takeDate(c.counts, 'visitor_count', row['checkin_date'], c.cutoverOn);
  if (date === null) return;
  const hash = hashOfCell(row['member_id']);
  const month = date.slice(0, 7);
  if (hash === '') {
    const cells = monthCells(c.counts, month);
    for (const metric of ['visits', 'visits_deduped']) {
      addCell(cells, metric, 'guest');
      addCell(cells, metric, '');
    }
    return;
  }
  c.entry('visits', month, { hash, second: secondOfMonth(cellText(row['checkin_date'])!) });
}

/** A `read_counter` row: one use in the library. */
export function countRead(c: RowContext, row: SlimsRow): void {
  const date = takeDate(c.counts, 'read_counter', row['created_at'], c.cutoverOn);
  if (date === null) return;
  addCell(monthCells(c.counts, date.slice(0, 7)), 'in_library_uses', '');
  countUse(c, date, cellText(row['item_code']), null);
}

// ---------------------------------------------------------------------------------------------------------------------
// The aggregate step

/**
 * Marks each of a month's check-ins kept (true) or a repeat (false), the check-ins sorted by member and time (ties keep
 * their order): a check-in is a repeat when the same member's previous one, kept or not, lies less than
 * `windowSeconds` before it; a member's first check-in of the month is compared with the one `carryIn` holds (its
 * second relative to this month's start, so ≤ 0). `windowSeconds` 0 keeps every check-in.
 */
export function markRepeats(entries: readonly MonthEntry[], carryIn: ReadonlyMap<string, number>, windowSeconds: number): { sorted: MonthEntry[]; kept: boolean[] } {
  const sorted = entries
    .map((e, at) => ({ e, at }))
    .sort((a, b) => (a.e.hash < b.e.hash ? -1 : a.e.hash > b.e.hash ? 1 : a.e.second - b.e.second || a.at - b.at))
    .map((x) => x.e);
  const kept: boolean[] = [];
  let member = '';
  let previous: number | null = null;
  for (const e of sorted) {
    if (e.hash !== member) {
      member = e.hash;
      previous = carryIn.get(e.hash) ?? null;
    }
    kept.push(previous === null || !(e.second - previous < windowSeconds));
    previous = e.second;
  }
  return { sorted, kept };
}

/**
 * What a month carries into the next one: for each member whose last check-in of the month lies less than
 * `windowSeconds` before the month's end, that check-in's second relative to the next month's start (≤ 0).
 * `sorted` is markRepeats' order.
 */
export function carryOut(sorted: readonly MonthEntry[], seconds: number, windowSeconds: number): Map<string, number> {
  const out = new Map<string, number>();
  if (windowSeconds <= 0) return out;
  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i]!;
    if (sorted[i + 1]?.hash === e.hash) continue;
    if (seconds - e.second < windowSeconds) out.set(e.hash, e.second - seconds);
  }
  return out;
}

/** What the aggregate step of one month reads, and the span sets it adds to. */
export interface AggregateMonthInput {
  month: string;
  /** The members' check-ins of the month (any order). */
  visits: readonly MonthEntry[];
  /** The members' loans of the month (any order). */
  borrows: readonly MonthEntry[];
  /** What the previous month carries in (carryOut). */
  carryIn: ReadonlyMap<string, number>;
  dedupeMinutes: number;
  members: ReadonlyMap<string, MemberInfo>;
  spans: readonly DateSpan[];
  /** Per span: the hashes of its visitors and of its borrowers, added to. */
  spanVisitors: readonly Set<string>[];
  spanBorrowers: readonly Set<string>[];
}

/**
 * The aggregate step of one month: adds its members' visits (raw and without repeats), distinct visitors and distinct
 * borrowers, by group and in total, to `counts`, and its visitors and borrowers to the span sets.
 *
 * @returns what the month carries into the next one
 */
export function aggregateMonth(counts: UsageCounts, o: AggregateMonthInput): Map<string, number> {
  const window = o.dedupeMinutes * 60;
  const cells = o.visits.length + o.borrows.length > 0 ? monthCells(counts, o.month) : null;
  const { sorted, kept } = markRepeats(o.visits, o.carryIn, window);
  const visitors = new Map<string, Set<string>>();
  const borrowers = new Map<string, Set<string>>();
  const distinct = (sets: Map<string, Set<string>>, group: string, hash: string): void => {
    for (const key of [group, '']) {
      let set = sets.get(key);
      if (set === undefined) sets.set(key, (set = new Set()));
      set.add(hash);
    }
  };
  sorted.forEach((e, i) => {
    const group = groupOfHash(e.hash, o.members);
    addCell(cells!, 'visits', group);
    addCell(cells!, 'visits', '');
    if (kept[i]) {
      addCell(cells!, 'visits_deduped', group);
      addCell(cells!, 'visits_deduped', '');
    }
    if (group === 'member_unknown') counts.memberUnknown.visits += 1;
    distinct(visitors, group, e.hash);
    for (const span of spansOf(o.spans, dateOfSecond(o.month, e.second))) o.spanVisitors[span]!.add(e.hash);
  });
  for (const e of o.borrows) {
    distinct(borrowers, groupOfHash(e.hash, o.members), e.hash);
    for (const span of spansOf(o.spans, dateOfSecond(o.month, e.second))) o.spanBorrowers[span]!.add(e.hash);
  }
  for (const [group, set] of visitors) addCell(cells!, 'distinct_visitors', group, set.size);
  for (const [group, set] of borrowers) addCell(cells!, 'distinct_borrowers', group, set.size);
  return carryOut(sorted, monthSeconds(o.month), window);
}

/** The cells of one span: distinct borrowers and visitors by group, members active by type, copies and titles used. */
export function spanCells(o: {
  span: DateSpan;
  members: ReadonlyMap<string, MemberInfo>;
  borrowers: ReadonlySet<string>;
  visitors: ReadonlySet<string>;
  items: number;
  titles: number;
}): UsageCells {
  const cells: UsageCells = {};
  if (o.titles > 0) addCell(cells, 'titles_used', '', o.titles);
  if (o.items > 0) addCell(cells, 'items_used', '', o.items);
  for (const [metric, hashes] of [
    ['distinct_borrowers', o.borrowers],
    ['distinct_visitors', o.visitors],
  ] as const) {
    for (const hash of hashes) {
      addCell(cells, metric, groupOfHash(hash, o.members));
      addCell(cells, metric, '');
    }
  }
  for (const member of o.members.values()) {
    if (member.type === null || member.expire === null || member.expire < o.span.to) continue;
    addCell(cells, 'members_active', `slims_type:${member.type}`);
    addCell(cells, 'members_active', '');
  }
  return cells;
}
