import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { RegisterKind } from '@altis/shared/api/accreditation';
import type { FieldWarning, StoreResponse } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../../context.js';

// What the five registers and the staff trainings share (spec §3.2, §10.6): errors, the row lock, the strict re-parse
// of a body, the trail of a new row, the optimistic update and the soft archive, and the audit entry.
//
// - The registers are the library's own administration, not a period's data: they stay editable while a period is
//   frozen, and no write here takes a period's lock.
// - Update and archive first lock their row with a write that changes nothing (`version = version`), so two writers of
//   one row serialize and what they read next is the latest commit (MySQL/MariaDB REPEATABLE READ included); then the
//   `version` the client read is compared (CONFLICT_STALE) and bumped by the UPDATE that writes the row, which repeats
//   the comparison in its WHERE.
// - An archived row is gone for the API: it cannot be changed or archived again (NOT_FOUND).
// - Every write audits once, with `meta {entity: <table>, id, fields}`: the names of the fields, never their values
//   (a staff member's name and appointment number are personal data).

/** The tables of the registers, and of the staff trainings (each the audit `entity` of its rows). */
export type RegisterTable =
  | 'library_activities'
  | 'library_staff'
  | 'staff_trainings'
  | 'library_partnerships'
  | 'library_budgets'
  | 'library_documents';

/** The table of each register. */
export const REGISTER_TABLE: Readonly<Record<RegisterKind, RegisterTable>> = Object.freeze({
  activities: 'library_activities',
  staff: 'library_staff',
  partnerships: 'library_partnerships',
  budgets: 'library_budgets',
  documents: 'library_documents',
});

export type Db = Kysely<DB> | Transaction<DB>;

/** The name of a row of each table in both languages, for the problem details. */
const NAMES: Readonly<Record<RegisterTable, readonly [string, string]>> = Object.freeze({
  library_activities: ['Kegiatan', 'activity'],
  library_staff: ['Tenaga perpustakaan', 'staff member'],
  staff_trainings: ['Pelatihan', 'training'],
  library_partnerships: ['Kerja sama', 'partnership'],
  library_budgets: ['Anggaran', 'budget'],
  library_documents: ['Dokumen', 'document'],
});

/** VALIDATION_FAILED with `errors` (`{path, code}`). */
export function validationFailed(errors: readonly FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data belum benar / The data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

/** `body` parsed with the strict API contract `schema`, or VALIDATION_FAILED with its issues as `{path, code}`. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

export function registerNotFound(table: RegisterTable): DomainError {
  const [id, en] = NAMES[table];
  return new DomainError('NOT_FOUND', { detail: `${id} tidak ditemukan / The ${en} was not found` });
}

export function registerStale(table: RegisterTable): DomainError {
  const [id, en] = NAMES[table];
  return new DomainError('CONFLICT_STALE', {
    detail: `${id} sudah diubah orang lain; muat ulang / The ${en} was changed by someone else; reload it`,
  });
}

/**
 * Locks the row `id` of `table` with a write that changes nothing; run it as the first statement of an update or an
 * archive. An unknown id locks nothing (the read after it answers NOT_FOUND).
 */
export async function lockRegisterRow(trx: Transaction<DB>, table: RegisterTable, id: string): Promise<void> {
  // Every register table has `id` and `version`; Kysely cannot narrow a union of table names.
  await trx
    .updateTable(table as 'library_activities')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/** The live row's version, checked against the one the client read. */
export function checkVersion(table: RegisterTable, row: { version: number | string }, version: number): void {
  if (Number(row.version) !== version) throw registerStale(table);
}

/** The trail of a new row written at `now` by `actorId`. */
export function newTrail(now: number, actorId: string | null) {
  return { archived_at: null, created_at: now, created_by: actorId, updated_at: now, updated_by: actorId };
}

/**
 * Writes `set` to the live row `id` of `table` whose version is still `version`, with `version + 1` and the trail.
 * Answers the new version.
 *
 * @throws DomainError CONFLICT_STALE when the row changed meanwhile (the lock taken first makes this a last guard)
 */
export async function writeRegisterRow(
  tx: TxCtx,
  table: RegisterTable,
  id: string,
  version: number,
  set: Record<string, unknown>,
  now: number,
): Promise<number> {
  const r = await tx.trx
    .updateTable(table as 'library_activities')
    .set((eb) => ({ ...(set as object), updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw registerStale(table);
  return version + 1;
}

/**
 * Archives the live row `id` of `table` (`archived_at = now`, `version + 1`, plus `extra`, e.g. a budget's freed scope
 * key) and audits `accreditation.register.archive`. Its files stay with it.
 *
 * @throws DomainError NOT_FOUND for an unknown or archived row
 */
export async function archiveRegisterTableRow(
  tx: TxCtx,
  table: RegisterTable,
  id: string,
  now: number,
  extra: (row: { id: string }) => Record<string, unknown> = () => ({}),
): Promise<StoreResponse> {
  const { trx } = tx;
  await lockRegisterRow(trx, table, id);
  const row = await trx
    .selectFrom(table as 'library_activities')
    .select(['id', 'version', 'archived_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw registerNotFound(table);
  const version = Number(row.version);
  const next = await tx.trx
    .updateTable(table as 'library_activities')
    .set((eb) => ({ ...(extra(row) as object), archived_at: now, updated_at: now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(next.numUpdatedRows) !== 1) throw registerStale(table);
  await auditRegister(tx, 'accreditation.register.archive', table, id, []);
  return { id, version: version + 1 };
}

/** Appends the register action `action` for row `id` of `table`: the names of the `fields`, never their values. */
export async function auditRegister(
  tx: TxCtx,
  action: 'accreditation.register.create' | 'accreditation.register.update' | 'accreditation.register.archive',
  table: RegisterTable,
  id: string,
  fields: readonly string[],
): Promise<void> {
  await tx.audit({ action, entity: table, entityId: id, meta: { entity: table, id, fields: [...fields] } });
}

/** An optional text as it is stored: null for absent, null or blank. */
export function textOrNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  return s.trim() === '' ? null : s;
}

/** A patch's optional text as it is stored: undefined (not sent), or null for a blank one. */
export function patchText(s: string | null | undefined): string | null | undefined {
  return s === undefined ? undefined : textOrNull(s);
}

/** A patch's optional value: undefined (not sent) or the value, null included. */
export function patchValue<T>(v: T | null | undefined): T | null | undefined {
  return v === undefined ? undefined : v;
}

/** A boolean as stored (0/1). */
export const flag = (b: boolean): number => (b ? 1 : 0);

/** A stored flag as a boolean (drivers answer 0/1, '0'/'1' or booleans). */
export const isFlag = (v: unknown): boolean => v === true || Number(v) === 1;

/** The keys of a body that hold a value: not undefined, null or a blank text; `version` and `branchId` aside. */
export function givenFields(body: object): string[] {
  return Object.entries(body)
    .filter(([k, v]) => k !== 'version' && k !== 'branchId' && v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === ''))
    .map(([k]) => k);
}

/**
 * The names of the fields of `next` (the patch's values as they would be stored, undefined = not sent) whose value
 * differs from `before`'s value of the same name.
 */
export function changedFields(next: object, before: object): string[] {
  const old = before as Readonly<Record<string, unknown>>;
  return Object.entries(next)
    .filter(([k, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify(old[k] ?? null))
    .map(([k]) => k);
}

/**
 * Checks that a span ends on or after its start (`YYYY-MM-DD` texts compare as dates): `{path: endPath, code:
 * 'invalid'}` otherwise. A missing end or start passes.
 */
export function checkSpan(start: string | null | undefined, end: string | null | undefined, endPath: string): void {
  if (start === null || start === undefined || end === null || end === undefined) return;
  if (end < start) throw validationFailed([{ path: endPath, code: 'invalid' }]);
}

/** At most this many ids in one `IN (…)` list. */
export const ID_BATCH = 500;

/** The `original_name` of each of the files `ids` (missing ones left out). */
export async function fileNames(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += ID_BATCH) {
    const batch = wanted.slice(i, i + ID_BATCH);
    const rows = await db.selectFrom('files').select(['id', 'original_name']).where('id', 'in', batch).execute();
    for (const r of rows) names.set(r.id, r.original_name);
  }
  return names;
}

/** Compares two optional dates, latest first, a missing one last. */
export function latestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

/** Compares two ids, newest first (ULIDs sort by time). */
export const newestIdFirst = (a: { id: string }, b: { id: string }): number => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
