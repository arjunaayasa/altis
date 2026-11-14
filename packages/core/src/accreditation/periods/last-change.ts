import type { DB } from '@altis/db';
import { addMonths, endOfMonth, monthOf } from '@altis/shared';
import type { UsageImportView } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import { slimsUsageRunSettings } from '../slims-usage/settings.js';

// The last change a period's computed results depend on (spec §10.4): the results are stale when anything they read
// changed at or after the evaluation started. It is the latest of
// - the period's own row (its profile, population and facilities: `updated_at`, `created_at`);
// - the `updated_at` of every live period whose span overlaps the days this one reads (its own span and the twelve
//   months before it, which the reading interest compares it with, in whole months, as the usage table is read: a
//   month cell covers its whole month, so a period that starts or ends inside a month reads that month's cells): a
//   write through such a period (a deleted usage cell, an archived evidence file) touches that period's row, and may
//   change what this one reads; the previous school year's period, which does not overlap this one, included, and so
//   is a period with free dates that only shares a month with this one;
// - every monthly usage cell and member type mapping (`usage_stats`, `usage_group_map`);
// - the five registers and the staff trainings (`updated_at`, `created_at`: an archive is a soft change of the row);
// - the evidence (`accred_evidence.created_at`);
// - the end of the latest succeeded real SLiMS migration (a catalogue sync included) and SLiMS usage import.
// The answers are left out: they are read as they are wherever they count. Catalogue edits are not tracked row by row
// (the workspace reminds the user to compute again after editing the catalogue).
//
// A maximum of timestamps cannot see a deleted row, so every writer that deletes touches a row read here in the same
// transaction (the period's `updated_at`, or the register row's).

type Db = Kysely<DB>;

/** A database maximum as a number (drivers answer a number, a bigint or a decimal string), or null. */
function timeOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The latest of `times`, or null when every one is null. */
export function latest(...times: readonly (number | null)[]): number | null {
  let out: number | null = null;
  for (const t of times) if (t !== null && (out === null || t > out)) out = t;
  return out;
}

/** The latest change of the rows every period depends on alike (everything but the periods themselves). */
export async function sharedLastChange(db: Db): Promise<number | null> {
  const times: (number | null)[] = [];
  const usage = await db.selectFrom('usage_stats').select((eb) => eb.fn.max('updated_at').as('m')).executeTakeFirst();
  times.push(timeOf(usage?.m));
  const groups = await db.selectFrom('usage_group_map').select((eb) => eb.fn.max('updated_at').as('m')).executeTakeFirst();
  times.push(timeOf(groups?.m));
  const registers = [
    await db.selectFrom('library_activities').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
    await db.selectFrom('library_staff').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
    await db.selectFrom('staff_trainings').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
    await db.selectFrom('library_partnerships').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
    await db.selectFrom('library_budgets').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
    await db.selectFrom('library_documents').select((eb) => [eb.fn.max('updated_at').as('u'), eb.fn.max('created_at').as('c')]).executeTakeFirst(),
  ];
  for (const r of registers) times.push(timeOf(r?.u), timeOf(r?.c));
  const evidence = await db.selectFrom('accred_evidence').select((eb) => eb.fn.max('created_at').as('m')).executeTakeFirst();
  times.push(timeOf(evidence?.m));
  times.push(await catalogSyncedAt(db));
  const usageImport = await db
    .selectFrom('catalog_runs')
    .select((eb) => eb.fn.max('finished_at').as('m'))
    .where('kind', '=', 'slims_usage')
    .where('status', '=', 'succeeded')
    .where('dry_run', '=', 0)
    .executeTakeFirst();
  times.push(timeOf(usageImport?.m));
  return latest(...times);
}

/** A period row as the period part of its last change reads it. */
export interface PeriodTimes {
  starts_on: string;
  ends_on: string;
  created_at: number | string | bigint;
  updated_at: number | string | bigint;
}

/** How many months before its start a period's results read data: the reading interest's previous twelve months. */
export const READ_MONTHS_BEFORE = 12;

/**
 * The days whose data the results of `p` read: from the first day of the month {@link READ_MONTHS_BEFORE} months
 * before its start to the last day of the month it ends in. The usage table is read in whole months (a month cell
 * covers its whole month), so this span is in whole months too.
 */
export function readSpanOf(p: { starts_on: string; ends_on: string }): { starts_on: string; ends_on: string } {
  return { starts_on: `${monthOf(addMonths(p.starts_on, -READ_MONTHS_BEFORE))}-01`, ends_on: endOfMonth(monthOf(p.ends_on)) };
}

/** The latest `updated_at` of the live periods whose span overlaps the days `p` reads (itself included when live). */
export async function overlappingChange(db: Db, p: PeriodTimes): Promise<number | null> {
  const read = readSpanOf(p);
  const r = await db
    .selectFrom('accred_periods')
    .select((eb) => eb.fn.max('updated_at').as('m'))
    .where('archived_at', 'is', null)
    .where('starts_on', '<=', read.ends_on)
    .where('ends_on', '>=', read.starts_on)
    .executeTakeFirst();
  return timeOf(r?.m);
}

/** The period part of a last change, with the overlapping periods' latest change already known. */
export function periodLastChange(p: PeriodTimes, overlapping: number | null): number | null {
  return latest(timeOf(p.updated_at), timeOf(p.created_at), overlapping);
}

/** True when `a` and `b` share at least one day. */
export function spansOverlap(a: { starts_on: string; ends_on: string }, b: { starts_on: string; ends_on: string }): boolean {
  return a.starts_on <= b.ends_on && b.starts_on <= a.ends_on;
}

/**
 * The latest change the results of period `periodId` depend on (see the top of this file), or null when nothing was
 * ever written. An unknown period has only the shared part.
 */
export async function lastChangeOf(db: Db, periodId: string): Promise<number | null> {
  const p = await db.selectFrom('accred_periods').select(['starts_on', 'ends_on', 'created_at', 'updated_at']).where('id', '=', periodId).executeTakeFirst();
  const own = p === undefined ? null : periodLastChange(p, await overlappingChange(db, p));
  return latest(own, await sharedLastChange(db));
}

/** When the catalogue was last taken from SLiMS: the end of the latest succeeded real migration (or sync), or null. */
export async function catalogSyncedAt(db: Db): Promise<number | null> {
  const r = await db
    .selectFrom('catalog_runs')
    .select((eb) => eb.fn.max('finished_at').as('m'))
    .where('kind', '=', 'migration')
    .where('status', '=', 'succeeded')
    .where('dry_run', '=', 0)
    .executeTakeFirst();
  return timeOf(r?.m);
}

/** The latest succeeded SLiMS usage import of this installation, with the cut-over day its options name; or null. */
export async function lastUsageImport(db: Db): Promise<UsageImportView | null> {
  const r = await db
    .selectFrom('catalog_runs')
    .select(['id', 'finished_at', 'options'])
    .where('kind', '=', 'slims_usage')
    .where('status', '=', 'succeeded')
    .where('dry_run', '=', 0)
    .where('finished_at', 'is not', null)
    .orderBy('finished_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (r === undefined) return null;
  let cutoverOn: string | null = null;
  try {
    const options = slimsUsageRunSettings.safeParse(JSON.parse(r.options));
    if (options.success) cutoverOn = options.data.cutoverOn;
  } catch {
    // Options that are not JSON name no cut-over day.
  }
  return { runId: r.id, finishedAt: Number(r.finished_at), cutoverOn };
}
