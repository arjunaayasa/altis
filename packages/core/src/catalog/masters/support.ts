import type { DB } from '@altis/db';
import { DomainError, isDomainError, normalizeKey } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';

// What the five master services share (Phase 2 spec §2.2, §12.2; plan Task 12): errors, the row lock, the strict
// re-parse of a body and the list filter. Internal to catalog/masters (M14): the barrel exports none of it.
//
// - A master's code is stored twice (`code_display` as typed, `code_key` = codeKey(), UNIQUE over every row, archived
//   ones included). A code another row holds is VALIDATION_FAILED `{path: 'code', code: 'taken'}`: checked first, and
//   again when the write itself loses the race for the key (UNIQUE_VIOLATION, which ends the transaction on
//   PostgreSQL: it is thrown at once, nothing runs after it).
// - Update and archive first lock their row with a write that changes nothing (`version = version`), so two writers of
//   one master serialize and what they read next is the latest commit (MySQL/MariaDB REPEATABLE READ included); then
//   `version` is compared (CONFLICT_STALE) and bumped by the UPDATE that writes the row.

export type Db = Kysely<DB> | Transaction<DB>;

/** The master tables (the audit `entity` of their actions, §12.4). */
export type MasterTable = 'material_types' | 'languages' | 'collection_types' | 'suppliers' | 'custom_field_defs';

/** A list answers at most this many rows (spec §12.2; plan Task 12). */
export const MASTER_LIST_MAX = 500;

/** At most this many ids in one `IN (…)` list. */
export const ID_BATCH = 500;

/** The name of each master in both languages, for the problem details. */
const NAMES: Readonly<Record<MasterTable, readonly [string, string]>> = Object.freeze({
  material_types: ['Jenis bahan', 'material type'],
  languages: ['Bahasa', 'language'],
  collection_types: ['Tipe koleksi', 'collection type'],
  suppliers: ['Pemasok', 'supplier'],
  custom_field_defs: ['Ruas tambahan', 'custom field'],
});

/** VALIDATION_FAILED with `errors` (`{path, code}`, D10). */
export function validationFailed(errors: readonly FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data belum benar / The data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

/** VALIDATION_FAILED for a code another row of the table holds. */
export function codeTaken(): DomainError {
  return validationFailed([{ path: 'code', code: 'taken' }]);
}

export function masterNotFound(table: MasterTable): DomainError {
  const [id, en] = NAMES[table];
  return new DomainError('NOT_FOUND', { detail: `${id} tidak ditemukan / The ${en} was not found` });
}

export function masterStale(table: MasterTable): DomainError {
  const [id, en] = NAMES[table];
  return new DomainError('CONFLICT_STALE', {
    detail: `${id} sudah diubah orang lain; muat ulang / The ${en} was changed by someone else; reload it`,
  });
}

/**
 * 409 CATALOG_IN_USE (decision P2-16, Review Focus 2) with `meta.count`. Problem bodies never carry `meta`, so the
 * count is in the bilingual detail as well.
 */
export function masterInUse(table: MasterTable, count: number): DomainError {
  const [id, en] = NAMES[table];
  const [what, whatEn] = table === 'collection_types' || table === 'suppliers' ? ['eksemplar', 'item(s)'] : ['cantuman', 'record(s)'];
  return new DomainError('CATALOG_IN_USE', {
    detail:
      `${id} ini masih dipakai ${count} ${what} aktif; ubah dahulu ${what} itu / ` +
      `This ${en} is still used by ${count} live ${whatEn}; change them first`,
    meta: { count },
  });
}

/** `body` parsed with the strict API contract `schema`, or VALIDATION_FAILED with its issues as `{path, code}`. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

/** Runs a write that may lose the race for a `code_key`: that UNIQUE_VIOLATION is a taken code. */
export async function takingCode<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw codeTaken();
    throw error;
  }
}

/**
 * Locks the master row `id` of `table` with a write that changes nothing. Run it as the first statement of an update or
 * an archive. An unknown id locks nothing (the read after it answers NOT_FOUND).
 */
export async function lockMasterRow(trx: Transaction<DB>, table: MasterTable, id: string): Promise<void> {
  // Every master table has `id` and `version`; Kysely cannot narrow a union of table names.
  await trx
    .updateTable(table as 'languages')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/** `s` with a blank text as null (an optional text field of a body: `''` clears it). */
export function blankToNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  return s.trim() === '' ? null : s;
}

/**
 * Whether a row matches the list's `q`: its normalized form (normalizeKey: NFKC, trimmed, spaces collapsed, upper
 * case) is part of one of `texts`, normalized the same way. Filtered in TypeScript, not with SQL `LIKE`, whose case
 * rules and escapes differ between the dialects; a master table is small.
 */
export function matchesQuery(q: string | undefined, texts: readonly (string | null)[]): boolean {
  if (q === undefined) return true;
  const needle = normalizeKey(q);
  if (needle === '') return true;
  return texts.some((t) => t !== null && normalizeKey(t).includes(needle));
}

/** The names of the fields whose new value differs from the stored one, in the order of `pairs`. */
export function changedFields(pairs: readonly (readonly [string, unknown, unknown])[]): string[] {
  return pairs.filter(([, next, before]) => next !== undefined && next !== before).map(([name]) => name);
}

/** The names of the keys of `body` that hold a value: not undefined, null or a blank text (which is stored as null). */
export function givenFields(body: object): string[] {
  return Object.entries(body)
    .filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === ''))
    .map(([k]) => k);
}
