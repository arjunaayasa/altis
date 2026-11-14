import type { DB } from '@altis/db';
import { DomainError, addDays, diffDays, isoWeekday, newId, type CalendarKind } from '@altis/shared';
import { CalendarBody, CalendarPatchBody, type CalendarQuery, type CalendarResponse, type CalendarRuleView } from '@altis/shared/api/circulation';
import type { Selectable, Transaction, Updateable } from 'kysely';
import type { TxCtx } from '../context.js';
import { memberValidationFailed, parseMemberBody, type Db } from '../members/common.js';

// The library calendar: the days the library is closed, and what they do to dates.
//
// - A rule closes a weekday every week (`weekly`, ISO 1 Monday … 7 Sunday), a range of dates (`dates`, both ends
//   included, at most 366 days), or a range of days every year (`yearly`, `MM-DD` to `MM-DD` within one year; 29
//   February closes only in a leap year). At most six weekdays may be closed, so that a week always has an open day.
// - In this edition every rule is library-wide (`branch_id` null); the lookup still takes the loan's branch, so a rule of
//   one branch would apply only there. The rules are read from the database in every transaction that needs them,
//   never cached.
// - The due date (computeDueDate): the rule's days after the start day; a closed day moves it to the next open day
//   (at most 366 steps, then CIRC_CALENDAR_CLOSED); past the member's last valid day it is cut back to that day, and a
//   closed day then steps back towards the start day; it is never before the start day.
// - countOpenDays counts the open days of a span, for late days that skip closed days.

type CalendarRow = Selectable<DB['calendars']>;

/** The fields of a rule that say which days it closes. */
export type ClosedDayRule = Pick<CalendarRow, 'kind' | 'weekday' | 'date_from' | 'date_to' | 'month_day_from' | 'month_day_to'>;

/** The most days a `dates` rule may span. */
export const CALENDAR_RANGE_MAX_DAYS = 366;

/** The most steps a due date moves forward past closed days before CIRC_CALENDAR_CLOSED. */
const MAX_STEPS = 366;

/** The longest span `GET circulation/calendar` lists closed dates for, in days. */
const SPAN_MAX_DAYS = 400;

/** Whether the rule `r` closes the date `d` (`YYYY-MM-DD`). Pure. */
export function ruleCloses(r: ClosedDayRule, d: string): boolean {
  switch (r.kind as CalendarKind) {
    case 'weekly':
      return r.weekday !== null && Number(r.weekday) === isoWeekday(d);
    case 'dates':
      return r.date_from !== null && r.date_to !== null && r.date_from <= d && d <= r.date_to;
    case 'yearly': {
      if (r.month_day_from === null || r.month_day_to === null) return false;
      const md = d.slice(5);
      return r.month_day_from <= md && md <= r.month_day_to;
    }
    default:
      return false;
  }
}

/** A predicate "is `d` closed" over `rules`. Pure. */
export function closedBy(rules: readonly ClosedDayRule[]): (d: string) => boolean {
  if (rules.length === 0) return () => false;
  return (d) => rules.some((r) => ruleCloses(r, d));
}

/** The live rules that apply at branch `branchId` (library-wide ones, and that branch's). */
export async function loadClosedDayRules(db: Db, branchId: string | null): Promise<ClosedDayRule[]> {
  let q = db.selectFrom('calendars').select(['kind', 'weekday', 'date_from', 'date_to', 'month_day_from', 'month_day_to']).where('archived_at', 'is', null);
  q = branchId === null ? q.where('branch_id', 'is', null) : q.where((eb) => eb.or([eb('branch_id', 'is', null), eb('branch_id', '=', branchId)]));
  return q.execute();
}

/** CIRC_CALENDAR_CLOSED. */
export function calendarClosed(): DomainError {
  return new DomainError('CIRC_CALENDAR_CLOSED', {
    detail: 'Kalender perpustakaan menutup semua hari sesudah tanggal jatuh tempo / The library calendar closes every day after the due date',
  });
}

/** What a due date is computed from (pure). */
export interface DueDateRule {
  /** The day the loan period starts: the day it was lent, or the day of a renewal. */
  loanedOn: string;
  /** The rule's loan days (0: due the same day). */
  days: number;
  /** The member's last valid day, or null when the membership never ends. */
  expiresOn: string | null;
}

/**
 * The due date (see the top of this file): `capped` when the member's expiry cut it, `moved` when closed days moved it
 * forward. Pure.
 *
 * @throws DomainError CIRC_CALENDAR_CLOSED when no open day comes within 366 days of `loanedOn + days`
 */
export function computeDueDate(i: DueDateRule, closed: (d: string) => boolean): { dueOn: string; capped: boolean; moved: boolean } {
  let d = addDays(i.loanedOn, i.days);
  let moved = false;
  for (let step = 0; closed(d); step++) {
    if (step >= MAX_STEPS) throw calendarClosed();
    d = addDays(d, 1);
    moved = true;
  }
  let capped = false;
  if (i.expiresOn !== null && d > i.expiresOn) {
    d = i.expiresOn;
    capped = true;
    moved = false;
    while (closed(d) && d > i.loanedOn) d = addDays(d, -1);
  }
  if (d < i.loanedOn) d = i.loanedOn;
  return { dueOn: d, capped, moved };
}

/** The open days after `from` up to and including `to` (0 when `to` is not after `from`). Pure. */
export function countOpenDays(closed: (d: string) => boolean, from: string, to: string): number {
  const span = diffDays(from, to);
  let open = 0;
  for (let k = 1; k <= span; k++) if (!closed(addDays(from, k))) open++;
  return open;
}

/**
 * The days late of a loan due `dueOn` and returned (or looked at) on `until`, in the calendar of `branchId`: every day
 * after the due date, or only its open days when `skipClosedDays`. For the fines.
 */
export async function lateDays(db: Db, i: { branchId: string; dueOn: string; until: string; skipClosedDays: boolean }): Promise<number> {
  const all = Math.max(0, diffDays(i.dueOn, i.until));
  if (all === 0 || !i.skipClosedDays) return all;
  return countOpenDays(closedBy(await loadClosedDayRules(db, i.branchId)), i.dueOn, i.until);
}

/** The closed dates from `from` to `to`, both included. Pure. */
export function closedDatesIn(rules: readonly ClosedDayRule[], from: string, to: string): string[] {
  const closed = closedBy(rules);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (closed(d)) out.push(d);
  return out;
}

// ---- the calendar API ----------------------------------------------------------------------------------------------------

function ruleNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Hari tutup tidak ditemukan / Closed day not found' });
}

function ruleStale(): DomainError {
  return new DomainError('CONFLICT_STALE', { detail: 'Hari tutup sudah diubah orang lain; muat ulang / The closed day was changed by someone else; reload it' });
}

function toView(r: CalendarRow): CalendarRuleView {
  return {
    id: r.id,
    kind: r.kind as CalendarKind,
    name: r.name,
    weekday: r.weekday === null ? null : Number(r.weekday),
    dateFrom: r.date_from,
    dateTo: r.date_to,
    monthDayFrom: r.month_day_from,
    monthDayTo: r.month_day_to,
    version: Number(r.version),
  };
}

const KIND_ORDER: Record<string, number> = { weekly: 0, yearly: 1, dates: 2 };

/**
 * The live rules (weekly by weekday, then yearly by day, then dates by start), and the closed dates of `from`…`to`
 * (`to` defaults to `from` + 41 days and may be at most 400 days after it).
 *
 * @throws DomainError VALIDATION_FAILED (`to`: `before_from`, `range_too_long`)
 */
export async function listCalendar(db: Db, q: CalendarQuery): Promise<CalendarResponse> {
  const rows = await db.selectFrom('calendars').selectAll().where('archived_at', 'is', null).where('branch_id', 'is', null).limit(2000).execute();
  const sortKey = (r: CalendarRow): string => `${KIND_ORDER[r.kind] ?? 9}|${r.weekday ?? ''}|${r.month_day_from ?? ''}|${r.date_from ?? ''}|${r.id}`;
  rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  let closed: string[] = [];
  if (q.from !== undefined) {
    const to = q.to ?? addDays(q.from, 41);
    if (to < q.from) throw memberValidationFailed([{ path: 'to', code: 'before_from' }]);
    if (diffDays(q.from, to) > SPAN_MAX_DAYS) throw memberValidationFailed([{ path: 'to', code: 'range_too_long' }]);
    closed = closedDatesIn(rows, q.from, to);
  }
  return { rules: rows.map(toView), closed };
}

/** The stored fields of a rule of `kind` from the values given; the fields of other kinds are null. */
interface RuleFields {
  weekday: number | null;
  date_from: string | null;
  date_to: string | null;
  month_day_from: string | null;
  month_day_to: string | null;
}

/** The field errors of a rule of `kind` with `f`; `exceptId` is the rule being edited (its own weekday does not count). */
async function ruleErrors(db: Db, kind: CalendarKind, f: RuleFields, exceptId?: string): Promise<{ path: string; code: string }[]> {
  const errors: { path: string; code: string }[] = [];
  const mustBeNull = (path: string, v: unknown): void => {
    if (v !== null) errors.push({ path, code: 'not_allowed' });
  };
  if (kind === 'weekly') {
    if (f.weekday === null) errors.push({ path: 'weekday', code: 'required' });
    mustBeNull('dateFrom', f.date_from);
    mustBeNull('dateTo', f.date_to);
    mustBeNull('monthDayFrom', f.month_day_from);
    mustBeNull('monthDayTo', f.month_day_to);
    if (f.weekday !== null) {
      let q = db.selectFrom('calendars').select('weekday').where('archived_at', 'is', null).where('branch_id', 'is', null).where('kind', '=', 'weekly');
      if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
      const days = new Set((await q.execute()).map((r) => Number(r.weekday)));
      days.add(f.weekday);
      if (days.size > 6) errors.push({ path: 'weekday', code: 'too_many_closed' });
    }
  } else if (kind === 'dates') {
    mustBeNull('weekday', f.weekday);
    mustBeNull('monthDayFrom', f.month_day_from);
    mustBeNull('monthDayTo', f.month_day_to);
    if (f.date_from === null) errors.push({ path: 'dateFrom', code: 'required' });
    else if (f.date_to !== null && f.date_to < f.date_from) errors.push({ path: 'dateTo', code: 'before_from' });
    else if (f.date_to !== null && diffDays(f.date_from, f.date_to) + 1 > CALENDAR_RANGE_MAX_DAYS) errors.push({ path: 'dateTo', code: 'range_too_long' });
  } else {
    mustBeNull('weekday', f.weekday);
    mustBeNull('dateFrom', f.date_from);
    mustBeNull('dateTo', f.date_to);
    if (f.month_day_from === null) errors.push({ path: 'monthDayFrom', code: 'required' });
    else if (f.month_day_to !== null && f.month_day_to < f.month_day_from) errors.push({ path: 'monthDayTo', code: 'crosses_year' });
  }
  return errors;
}

/** The stored fields of a create body: an absent end of the kind's range is its start (one day). */
function fieldsOf(b: CalendarBody): RuleFields {
  const dateFrom = b.dateFrom ?? null;
  const monthDayFrom = b.monthDayFrom ?? null;
  return {
    weekday: b.weekday ?? null,
    date_from: dateFrom,
    date_to: b.dateTo ?? (b.kind === 'dates' ? dateFrom : null),
    month_day_from: monthDayFrom,
    month_day_to: b.monthDayTo ?? (b.kind === 'yearly' ? monthDayFrom : null),
  };
}

/** Serialises the writers of the calendar on the first live weekly rule, so two never both pass the six-weekday check. */
async function lockCalendar(trx: Transaction<DB>): Promise<void> {
  await trx
    .updateTable('calendars')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('archived_at', 'is', null)
    .where('kind', '=', 'weekly')
    .execute();
}

/**
 * Adds closed days and audits `circulation.calendar.create` with the kind.
 *
 * @throws DomainError VALIDATION_FAILED (the contract; `required`, `not_allowed`, `too_many_closed`, `before_from`,
 *   `range_too_long`, `crosses_year`; `{path: 'branchId', code: 'branch_scope_not_available'}`)
 */
export async function createCalendarRule(tx: TxCtx, input: CalendarBody): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(CalendarBody, input);
  const { trx } = tx;
  await lockCalendar(trx);
  const f = fieldsOf(b);
  const errors = await ruleErrors(trx, b.kind, f);
  if (errors.length > 0) throw memberValidationFailed(errors);
  const id = newId(tx.now);
  await trx
    .insertInto('calendars')
    .values({
      id,
      branch_id: null,
      kind: b.kind,
      ...f,
      name: b.name,
      archived_at: null,
      version: 0,
      created_at: tx.now,
      created_by: tx.actor.id,
      updated_at: tx.now,
      updated_by: tx.actor.id,
    })
    .execute();
  await tx.audit({ action: 'circulation.calendar.create', entity: 'calendars', entityId: id, meta: { kind: b.kind } });
  return { id, version: 0 };
}

async function lockRule(trx: Transaction<DB>, id: string): Promise<CalendarRow> {
  await trx
    .updateTable('calendars')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
  const row = await trx.selectFrom('calendars').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw ruleNotFound();
  return row;
}

/**
 * Changes the fields `patch` sends (the kind stays) and audits `circulation.calendar.update` with the names of the
 * fields whose value changed.
 *
 * @throws DomainError NOT_FOUND (none, or archived); CONFLICT_STALE; VALIDATION_FAILED (as createCalendarRule)
 */
export async function updateCalendarRule(tx: TxCtx, id: string, input: CalendarPatchBody): Promise<{ id: string; version: number }> {
  const p = parseMemberBody(CalendarPatchBody, input);
  const { trx } = tx;
  await lockCalendar(trx);
  const before = await lockRule(trx, id);
  if (Number(before.version) !== p.version) throw ruleStale();
  if (before.archived_at !== null) throw ruleNotFound();
  const pick = <T>(sent: T | undefined, stored: T): T => (sent === undefined ? stored : sent);
  const f: RuleFields = {
    weekday: pick(p.weekday, before.weekday === null ? null : Number(before.weekday)),
    date_from: pick(p.dateFrom, before.date_from),
    date_to: pick(p.dateTo, before.date_to),
    month_day_from: pick(p.monthDayFrom, before.month_day_from),
    month_day_to: pick(p.monthDayTo, before.month_day_to),
  };
  const errors = await ruleErrors(trx, before.kind as CalendarKind, f, id);
  if (errors.length > 0) throw memberValidationFailed(errors);
  const set: Updateable<DB['calendars']> = {};
  const fields: string[] = [];
  const changes: [string, keyof RuleFields | 'name', unknown, unknown][] = [
    ['name', 'name', p.name ?? before.name, before.name],
    ['weekday', 'weekday', f.weekday, before.weekday === null ? null : Number(before.weekday)],
    ['dateFrom', 'date_from', f.date_from, before.date_from],
    ['dateTo', 'date_to', f.date_to, before.date_to],
    ['monthDayFrom', 'month_day_from', f.month_day_from, before.month_day_from],
    ['monthDayTo', 'month_day_to', f.month_day_to, before.month_day_to],
  ];
  for (const [field, column, next, old] of changes) {
    if (next === old) continue;
    (set as Record<string, unknown>)[column] = next;
    fields.push(field);
  }
  const updated = await trx
    .updateTable('calendars')
    .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', p.version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw ruleStale();
  await tx.audit({ action: 'circulation.calendar.update', entity: 'calendars', entityId: id, meta: { fields: fields.sort() } });
  return { id, version: p.version + 1 };
}

/**
 * Removes closed days (archives the rule) and audits `circulation.calendar.archive`. One already archived is answered
 * as it is (`meta.alreadyArchived`).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE
 */
export async function archiveCalendarRule(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  const before = await lockRule(trx, id);
  if (Number(before.version) !== version) throw ruleStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'circulation.calendar.archive', entity: 'calendars', entityId: id, meta: { alreadyArchived: true } });
    return { id, version };
  }
  const updated = await trx
    .updateTable('calendars')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw ruleStale();
  await tx.audit({ action: 'circulation.calendar.archive', entity: 'calendars', entityId: id, meta: {} });
  return { id, version: version + 1 };
}
