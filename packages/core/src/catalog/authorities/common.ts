import { normalizeDbError, type DB } from '@altis/db';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import { sql, type Expression, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { z } from 'zod';

// What the authority services of Phase 2 Task 13 share (spec §3.5): their errors, the row lock, the text clean-up, the
// list cursor and the `q` filter. Internal to catalog/authorities (not in the barrel, M14).

export type Db = Kysely<DB> | Transaction<DB>;

/** The three authority tables (`AuthorityKind` of the API contract). */
export type AuthorityTable = 'agents' | 'subjects' | 'publishers';

/** Up to this many ids per `IN (…)` list (every engine caps a statement's parameters). */
export const ID_BATCH = 500;

/** The noun of each kind in the bilingual problem details. */
const NOUN: Readonly<Record<AuthorityTable, string>> = Object.freeze({
  agents: 'Nama / Name',
  subjects: 'Subjek / Subject',
  publishers: 'Penerbit / Publisher',
});

export function authorityNotFound(kind: AuthorityTable): DomainError {
  return new DomainError('NOT_FOUND', { detail: `${NOUN[kind]}: tidak ditemukan / not found` });
}

export function authorityStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Otoritas ini sudah diubah orang lain; muat ulang / This authority was changed by someone else; reload it',
  });
}

/** A merged authority lives on in its target: it is not edited, restored or merged again. */
export function mergedAuthority(): DomainError {
  return new DomainError('CATALOG_MERGE_INVALID', {
    detail: 'Otoritas ini sudah digabungkan ke otoritas lain / This authority was merged into another one',
  });
}

export function mergeInvalid(detail: string): DomainError {
  return new DomainError('CATALOG_MERGE_INVALID', { detail });
}

export function validationFailed(errors: FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Data otoritas tidak valid / The authority data is not valid', meta: { errors } });
}

/**
 * `body` parsed again with its strict contract (a caller that is not the API meets the same widths), or
 * VALIDATION_FAILED with its issues as field errors (D10).
 */
export function parseOrFail<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw validationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

/**
 * 409 CATALOG_IN_USE: `count` live records still link to the authority (§3.5; the way out is a merge). Problem bodies
 * never carry `meta`, so the count is in the bilingual `detail` as well.
 */
export function inUse(count: number): DomainError {
  return new DomainError('CATALOG_IN_USE', {
    detail:
      `Otoritas ini masih dipakai ${count} cantuman; gabungkan ke otoritas lain bila ingin menghapusnya / ` +
      `This authority is still used by ${count} record(s); merge it into another one to retire it`,
    meta: { count },
  });
}

/** True for a UNIQUE_VIOLATION of the driver (a concurrent insert or rename of the same key). */
export function isUniqueViolation(error: unknown): boolean {
  const normalized = normalizeDbError(error);
  return isDomainError(normalized) && normalized.code === 'UNIQUE_VIOLATION';
}

/**
 * The revival of an archived authority matched no row (L01): another transaction merged, revived, renamed or removed it
 * after this one read it, which a MySQL/MariaDB REPEATABLE READ snapshot does not show. withTx runs the transaction
 * again, whose reads see that commit.
 */
export function revivalConflict(): DomainError {
  return new DomainError('TX_CONFLICT', {
    detail: 'Otoritas diubah orang lain selagi dipulihkan; transaksi diulang / The authority changed while it was revived; the transaction is run again',
    meta: { attempts: 1, code: 'AUTHORITY_REVIVAL' },
  });
}

/**
 * Locks the rows of `ids` in `table` with a write that changes nothing (the records' lockRecordRows pattern): writers
 * of the same authorities serialize, and on MySQL/MariaDB (REPEATABLE READ) the reads that follow see the latest
 * commit. One statement for all of them, so the rows are locked in index order in every transaction.
 */
export async function lockAuthorityRows(trx: Transaction<DB>, table: AuthorityTable, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    // The three tables share these columns; Kysely cannot narrow a union of table names.
    await trx
      .updateTable(table as 'agents')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
  }
}

/** A single-line value as stored: trimmed, inner whitespace collapsed. */
export function oneLine(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** An optional single-line value: undefined (not sent) stays undefined, '' becomes null. */
export function optionalLine(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = oneLine(v);
  return s === '' ? null : s;
}

/** An optional free text (note, scope note), kept as written: undefined stays undefined, blank becomes null. */
export function optionalText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v.trim() === '' ? null : v;
}

/** The cursor of a keyset list in key order: the last row's id (a key may be longer than a cursor may be). */
export function keyCursor(id: string): string {
  return `k.${id}`;
}

/**
 * The id a {@link keyCursor} names, or VALIDATION_FAILED at `cursor` (`invalid`) for a cursor that does not parse.
 */
export function cursorId(cursor: string): string {
  const id = /^k\.([0-9A-Z]{26})$/.exec(cursor)?.[1];
  if (id === undefined || !isUlid(id)) throw validationFailed([{ path: 'cursor', code: 'invalid' }]);
  return id;
}

/** `s` with the LIKE wildcards (and the escape character `!`) escaped for `LIKE … ESCAPE '!'`. */
function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

/** `column LIKE '%<needle>%'` with the needle's wildcards literal (keys are upper case and binary on every engine). */
export function keyContains(column: Expression<string>, needle: string): Expression<SqlBool> {
  return sql<SqlBool>`${column} like ${`%${escapeLike(needle)}%`} escape '!'`;
}
