import { countRows, type DB } from '@altis/db';
import { DomainError, isDomainError, localDate, newId, type MemberEventType, type MemberStatus } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import { sql, type Expression, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { TxCtx } from '../context.js';
import { readSettings } from '../settings/service.js';

// What the members services share: errors, the strict re-parse of a body, the library's "today", the status a member is
// shown with, the member lock and the history rows.
//
// - Every write of a member (an edit, a suspension, an extension, an archive) and every loan, return and renewal locks
//   the member's row with a write that changes nothing and matches only a member that is neither archived nor
//   anonymised (lockLiveMember). It is a locking statement, so writers of one member serialise, and the reads after it
//   see the latest commit; when it matches nothing the member is gone for the action (404).
// - `member_events.meta` names fields (and an extension's old and new expiry), never a personal value.

export type Db = Kysely<DB> | Transaction<DB>;

/** VALIDATION_FAILED with `errors` (`{path, code}`). */
export function memberValidationFailed(errors: readonly FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data anggota belum benar / The member data is not valid',
    meta: { errors: errors.map((e) => ({ path: e.path, code: e.code })) },
  });
}

export function memberNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Anggota tidak ditemukan / Member not found' });
}

export function memberStale(): DomainError {
  return new DomainError('CONFLICT_STALE', { detail: 'Data anggota sudah diubah orang lain; muat ulang / The member was changed by someone else; reload it' });
}

export function memberTypeNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Tipe anggota tidak ditemukan / Member type not found' });
}

/** `body` parsed with the strict API contract `schema`, or VALIDATION_FAILED with its issues as `{path, code}`. */
export function parseMemberBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw memberValidationFailed(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) })));
}

/** Runs a write that may lose the race for a unique key: that UNIQUE_VIOLATION is the field error `{path, code: 'taken'}`. */
export async function takenOnRace<T>(path: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw memberValidationFailed([{ path, code: 'taken' }]);
    throw error;
  }
}

/** A blank text as null. */
export function textOrNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** The library's time zone (`library.timezone`). */
export async function libraryTimeZone(db: Db): Promise<string> {
  return (await readSettings(db, ['library.timezone'], []))['library.timezone'] as string;
}

/** Today in the library's time zone at `now`. */
export async function libraryToday(db: Db, now: number): Promise<string> {
  return localDate(await libraryTimeZone(db), now);
}

/** The status a member is shown with (anonymised, archived, suspended, expired, else active), on `today`. */
export function memberStatusOf(row: { anonymized_at: number | null; archived_at: number | null; status: string; expires_on: string | null }, today: string): MemberStatus {
  if (row.anonymized_at !== null) return 'anonymized';
  if (row.archived_at !== null) return 'archived';
  if (row.status === 'suspended') return 'suspended';
  if (row.expires_on !== null && row.expires_on < today) return 'expired';
  return 'active';
}

/**
 * The condition of a shown status on the members table (alias `m`) on `today`, the same order as memberStatusOf. A
 * status that cannot match (none) is a condition that is always false.
 */
export function memberStatusWhere(status: MemberStatus, today: string): Expression<SqlBool> {
  switch (status) {
    case 'anonymized':
      return sql<SqlBool>`m.anonymized_at is not null`;
    case 'archived':
      return sql<SqlBool>`(m.anonymized_at is null and m.archived_at is not null)`;
    case 'suspended':
      return sql<SqlBool>`(m.anonymized_at is null and m.archived_at is null and m.status = 'suspended')`;
    case 'expired':
      return sql<SqlBool>`(m.anonymized_at is null and m.archived_at is null and m.status <> 'suspended' and m.expires_on is not null and m.expires_on < ${today})`;
    case 'active':
      return sql<SqlBool>`(m.anonymized_at is null and m.archived_at is null and m.status <> 'suspended' and (m.expires_on is null or m.expires_on >= ${today}))`;
  }
}

/**
 * Locks the member `id` with a write that changes nothing and matches only a member that is neither archived nor
 * anonymised (see the top of this file); whether it matched.
 */
export async function lockLiveMember(trx: Transaction<DB>, id: string): Promise<boolean> {
  const locked = await trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .where('anonymized_at', 'is', null)
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1;
}

/** The history rows of a member, written by the transaction's actor at its time. */
export async function writeMemberEvents(tx: TxCtx, memberId: string, events: readonly { type: MemberEventType; meta?: Record<string, unknown> }[]): Promise<void> {
  for (const e of events) {
    await tx.trx
      .insertInto('member_events')
      .values({ id: newId(tx.now), member_id: memberId, at: tx.now, type: e.type, actor_type: tx.actor.type, actor_id: tx.actor.id, meta: JSON.stringify(e.meta ?? {}) })
      .execute();
  }
}

/** The number of open loans of the member `memberId` (in `db`, e.g. after its lock). */
export async function openLoanCount(db: Db, memberId: string): Promise<number> {
  return countRows(db.selectFrom('loans').select('id').where('member_id', '=', memberId).where('open_item_id', 'is not', null));
}
