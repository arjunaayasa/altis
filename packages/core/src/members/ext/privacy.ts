import { PERSONAL_COLUMNS, type DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { MemberDataExport } from '@altis/shared/api/member-ops';
import type { Kysely, Transaction, Updateable } from 'kysely';
import type { TxCtx } from '../../context.js';
import { memberNotFound, memberStale, memberValidationFailed, openLoanCount, writeMemberEvents } from '../common.js';
import { memberNameKey, normalizeMemberNo } from '../keys.js';
import { memberInUse } from './bulk.js';
import { memberBalanceMinor, memberDataSections, memberErasureSteps } from './hooks.js';

// A member's personal data (Indonesia's personal data protection law): the export of everything stored about one
// member, and anonymisation.
//
// Export: the member row's every column (its personal columns included; never the password hash), the custom field
// values, the history, the loans (title, barcode, dates), the visits, and the sections other modules register
// (holds, fines and payments, bookmarks). The photo is named by its file id; staff download it apart.
//
// Anonymisation, in one transaction (the stored photo content after the commit), refused while the member has open
// loans or owes anything (MEMBER_IN_USE):
//   1. the member row: every column registered as personal data is emptied (the name becomes "Anggota dianonimkan",
//      the number `ANON-<id>`), the password hash and the source are cleared, the member is archived and anonymised,
//      and `session_version` moves on (every member session ends);
//   2. the member's custom field values, password reset tokens and sessions are deleted;
//   3. the free text that could name the member on history rows is emptied (a loan's override note, a visit's note)
//      and a visit's day key, which holds the member id, is cleared;
//   4. the SLiMS migration's map rows that point at the member are deleted;
//   5. the photo's file row is deleted (its content after the commit);
//   6. each step other modules registered (holds closed, notices and bookmarks deleted, fine texts emptied, archived
//      migration rows removed) runs;
//   7. history `anonymized` (no value).
// The history rows themselves stay, pointing at the anonymous member: dates, counts, the type, group and class a visit
// or a loan was counted under. It cannot be undone.

type Db = Kysely<DB> | Transaction<DB>;

/** The name an anonymised member keeps. */
export const ANONYMIZED_NAME = 'Anggota dianonimkan';

/** The member number an anonymised member keeps. */
export function anonymizedMemberNo(id: string): string {
  return `ANON-${id}`;
}

/** The columns of `members` never exported: credentials. */
const NEVER_EXPORTED: ReadonlySet<string> = new Set(['password_hash']);

/**
 * Everything stored about the member `id` (see the top of this file), for a JSON download. A member's own export and
 * staff's use the same document.
 *
 * @throws DomainError NOT_FOUND (none, or anonymised: nothing personal is left)
 */
export async function exportMemberData(db: Db, id: string, now: number): Promise<MemberDataExport> {
  const row = await db.selectFrom('members').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.anonymized_at !== null) throw memberNotFound();
  const member: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!NEVER_EXPORTED.has(key)) member[key] = typeof value === 'bigint' ? Number(value) : value;
  const type = await db.selectFrom('member_types').select(['code_display', 'name_id']).where('id', '=', row.member_type_id).executeTakeFirst();
  member['member_type'] = type === undefined ? null : { code: type.code_display, name: type.name_id };

  const custom: Record<string, unknown> = {};
  const values = await db
    .selectFrom('custom_values as v')
    .innerJoin('custom_field_defs as d', 'd.id', 'v.field_id')
    .select(['d.code_display', 'v.value'])
    .where('d.entity', '=', 'members')
    .where('v.entity_id', '=', id)
    .execute();
  for (const v of values) {
    try {
      custom[v.code_display] = JSON.parse(v.value) as unknown;
    } catch {
      custom[v.code_display] = v.value;
    }
  }

  const events = await db.selectFrom('member_events').select(['at', 'type', 'actor_type', 'meta']).where('member_id', '=', id).orderBy('at').orderBy('id').execute();
  const loans = await db
    .selectFrom('loans as l')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .select(['r.title', 'i.barcode_display', 'l.loaned_on', 'l.due_on', 'l.renewals', 'l.returned_on', 'l.outcome', 'l.override_note'])
    .where('l.member_id', '=', id)
    .orderBy('l.loaned_at')
    .orderBy('l.id')
    .execute();
  const visits = await db
    .selectFrom('visits')
    .select(['visited_on', 'visited_at', 'branch_id', 'source', 'purpose', 'class_name', 'note'])
    .where('member_id', '=', id)
    .where('voided_at', 'is', null)
    .orderBy('visited_at')
    .orderBy('id')
    .execute();
  const sections: Record<string, unknown[]> = {
    events: events.map((e) => ({ at: Number(e.at), type: e.type, actorType: e.actor_type, meta: safeJson(e.meta) })),
    loans: loans.map((l) => ({
      title: l.title ?? null,
      barcode: l.barcode_display ?? null,
      loanedOn: l.loaned_on,
      dueOn: l.due_on,
      renewals: Number(l.renewals),
      returnedOn: l.returned_on,
      outcome: l.outcome,
      note: l.override_note,
    })),
    visits: visits.map((v) => ({ visitedOn: v.visited_on, visitedAt: Number(v.visited_at), branchId: v.branch_id, source: v.source, purpose: v.purpose, className: v.class_name, note: v.note })),
  };
  for (const s of memberDataSections()) sections[s.name] = await s.read(db, id);
  return { format: 'altis-member-data', version: 1, exportedAt: now, member, custom, photoFileId: row.photo_file_id, sections };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/** Every personal column of `members` emptied (see the top of this file), with the anonymous name and number. */
function anonymousMemberSet(id: string, now: number): Updateable<DB['members']> {
  const set: Record<string, unknown> = {};
  for (const p of PERSONAL_COLUMNS.members ?? []) set[p.column] = null;
  const no = anonymizedMemberNo(id);
  return {
    ...(set as Updateable<DB['members']>),
    name: ANONYMIZED_NAME,
    name_key: memberNameKey(ANONYMIZED_NAME),
    member_no_display: no,
    member_no_key: normalizeMemberNo(no),
    password_hash: null,
    must_reset_password: 0,
    source: null,
    anonymized_at: now,
    archived_at: now,
  };
}

/**
 * Anonymises the member `id` (see the top of this file). Answers the new version and the files whose stored content
 * the caller deletes after the commit. `o.audit` false: the daily job audits its run once instead.
 *
 * @throws DomainError NOT_FOUND (none); MEMBER_ANONYMIZED; CONFLICT_STALE (`version` given and stale); MEMBER_IN_USE
 *   `{openLoans, balanceMinor}`; VALIDATION_FAILED `{path: 'confirmMemberNo', code: 'mismatch'}`
 */
export async function anonymizeMember(
  tx: TxCtx,
  id: string,
  o: { version?: number; confirmMemberNo?: string; audit?: boolean; archived?: boolean } = {},
): Promise<{ id: string; version: number; deleteFiles: string[] }> {
  const { trx } = tx;
  // The lock is the first statement. An archived member (the daily job's) is locked by the same no-op write, matching
  // only a member not anonymised yet.
  const locked = await trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('anonymized_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) !== 1) {
    const exists = await trx.selectFrom('members').select('anonymized_at').where('id', '=', id).executeTakeFirst();
    if (exists === undefined) throw memberNotFound();
    throw new DomainError('MEMBER_ANONYMIZED', { detail: 'Anggota ini sudah dianonimkan / This member has been anonymised already' });
  }
  const row = await trx.selectFrom('members').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  if (o.version !== undefined && Number(row.version) !== o.version) throw memberStale();
  if (o.confirmMemberNo !== undefined && normalizeMemberNo(o.confirmMemberNo) !== row.member_no_key) {
    throw memberValidationFailed([{ path: 'confirmMemberNo', code: 'mismatch' }]);
  }
  const openLoans = await openLoanCount(trx, id);
  const balance = await memberBalanceMinor(trx, id);
  if (openLoans > 0 || balance > 0) throw memberInUse(openLoans, balance);

  const deleteFiles: string[] = [];
  if (row.photo_file_id !== null) {
    await trx.deleteFrom('files').where('id', '=', row.photo_file_id).execute();
    deleteFiles.push(row.photo_file_id);
  }
  const updated = await trx
    .updateTable('members')
    .set((eb) => ({
      ...anonymousMemberSet(id, tx.now),
      session_version: eb('session_version', '+', 1),
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .where('version', '=', Number(row.version))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();

  const memberFields = await trx.selectFrom('custom_field_defs').select('id').where('entity', '=', 'members').execute();
  if (memberFields.length > 0) {
    await trx
      .deleteFrom('custom_values')
      .where('entity_id', '=', id)
      .where(
        'field_id',
        'in',
        memberFields.map((f) => f.id),
      )
      .execute();
  }
  await trx.deleteFrom('password_resets').where('subject_type', '=', 'member').where('subject_id', '=', id).execute();
  await trx.deleteFrom('sessions').where('subject_type', '=', 'member').where('subject_id', '=', id).execute();
  await trx.updateTable('loans').set({ override_note: null }).where('member_id', '=', id).where('override_note', 'is not', null).execute();
  await trx.updateTable('visits').set({ note: null, day_key: null }).where('member_id', '=', id).execute();
  await trx.deleteFrom('migration_map').where('target_id', '=', id).execute();
  for (const step of memberErasureSteps()) await step.run(tx, id);
  await writeMemberEvents(tx, id, [{ type: 'anonymized' }]);
  if (o.audit !== false) await tx.audit({ action: 'members.privacy.anonymize', entity: 'members', entityId: id, meta: {} });
  return { id, version: Number(row.version) + 1, deleteFiles };
}

