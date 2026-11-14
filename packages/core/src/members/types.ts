import { countGrouped, countRows, type DB } from '@altis/db';
import { DomainError, newId, type AccredGroup } from '@altis/shared';
import { MemberTypeBody, MemberTypePatchBody, type MemberTypeListQuery, type MemberTypeView } from '@altis/shared/api/members';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { codeKey } from '../catalog/data/keys.js';
import type { TxCtx } from '../context.js';
import { memberTypeNotFound, memberValidationFailed, parseMemberBody, takenOnRace, type Db } from './common.js';

// Member types: what kind of member someone is (pupil, teacher, the public, ...), how long a membership lasts
// (`membership_days`, null = never expires), how many open loans a member may hold (`loan_limit`, null = no limit, 0 =
// may not borrow), holds and online renewal (stored for later work), and the population group the type counts in.
//
// - The code is stored twice (`code_display` as typed, `code_key` = codeKey(), unique over every row, archived ones
//   included): a taken code is `{path: 'code', code: 'taken'}`.
// - An update and an archive lock the row first (a write that changes nothing), then compare `version`. Saving a type
//   never changes its members' dates.
// - A type that live members (not archived, not anonymised) use cannot be archived: 409 MEMBER_TYPE_IN_USE
//   `{count}`. A member's create and type change lock the type's row while it is live, so the two serialise.

type Row = Selectable<DB['member_types']>;

const flag = (b: boolean): 0 | 1 => (b ? 1 : 0);

function toView(row: Row, memberCount: number): MemberTypeView {
  return {
    id: row.id,
    code: row.code_display,
    nameId: row.name_id,
    nameEn: row.name_en,
    accredGroup: row.accred_group as AccredGroup,
    membershipDays: row.membership_days === null ? null : Number(row.membership_days),
    loanLimit: row.loan_limit === null ? null : Number(row.loan_limit),
    holdsAllowed: Number(row.holds_allowed) === 1,
    holdsLimit: Number(row.holds_limit),
    onlineRenewal: Number(row.online_renewal) === 1,
    sortOrder: Number(row.sort_order),
    memberCount,
    archived: row.archived_at !== null,
    version: Number(row.version),
  };
}

function memberTypeStale(): DomainError {
  return new DomainError('CONFLICT_STALE', { detail: 'Tipe anggota sudah diubah orang lain; muat ulang / The member type was changed by someone else; reload it' });
}

/** True when a member type other than `exceptId` holds `key` (archived ones included). */
async function keyTaken(db: Db, key: string, exceptId?: string): Promise<boolean> {
  let q = db.selectFrom('member_types').select('id').where('code_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/** The live members (not archived, not anonymised) of each type of `ids`. */
async function liveMemberCounts(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const q = db.selectFrom('members').where('member_type_id', 'in', [...ids]).where('archived_at', 'is', null).where('anonymized_at', 'is', null);
  for (const row of await countGrouped(q, { t: 'member_type_id' })) out.set(String(row.t), row.count);
  return out;
}

/** The member types by `sort_order`, then code; archived ones only with `includeArchived`. */
export async function listMemberTypes(db: Db, q: MemberTypeListQuery): Promise<MemberTypeView[]> {
  let query = db.selectFrom('member_types').selectAll();
  if (q.includeArchived !== true) query = query.where('archived_at', 'is', null);
  const rows = await query.orderBy('sort_order').orderBy('code_key').orderBy('id').limit(500).execute();
  const counts = await liveMemberCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toView(r, counts.get(r.id) ?? 0));
}

/** The member type `id` as its view, or NOT_FOUND. */
export async function getMemberType(db: Db, id: string): Promise<MemberTypeView> {
  const row = await db.selectFrom('member_types').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) throw memberTypeNotFound();
  return toView(row, (await liveMemberCounts(db, [id])).get(id) ?? 0);
}

/**
 * Creates a member type and audits `members.type.create` (`meta.fields`: the names of the fields given).
 *
 * @throws DomainError VALIDATION_FAILED (the contract, or `{path: 'code', code: 'taken'}`)
 */
export async function createMemberType(tx: TxCtx, input: MemberTypeBody): Promise<{ id: string; version: number }> {
  const b = parseMemberBody(MemberTypeBody, input);
  const { trx } = tx;
  const key = codeKey(b.code);
  if (await keyTaken(trx, key)) throw memberValidationFailed([{ path: 'code', code: 'taken' }]);
  const id = newId(tx.now);
  await takenOnRace('code', () =>
    trx
      .insertInto('member_types')
      .values({
        id,
        code_display: b.code,
        code_key: key,
        name_id: b.nameId,
        name_en: b.nameEn ?? null,
        accred_group: b.accredGroup,
        membership_days: b.membershipDays,
        loan_limit: b.loanLimit,
        holds_allowed: flag(b.holdsAllowed),
        holds_limit: b.holdsLimit,
        online_renewal: flag(b.onlineRenewal),
        sort_order: b.sortOrder,
        archived_at: null,
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute(),
  );
  const fields = Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined);
  await tx.audit({ action: 'members.type.create', entity: 'member_types', entityId: id, meta: { fields: fields.sort() } });
  return { id, version: 0 };
}

/** Locks the member type row `id` with a write that changes nothing. */
async function lockTypeRow(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('member_types')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/**
 * Changes the fields `patch` sends, `version` + 1, and audits `members.type.update` with the names of the fields whose
 * value changed. The members of the type keep their dates.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED (the contract, or a taken code)
 */
export async function updateMemberType(tx: TxCtx, id: string, input: MemberTypePatchBody): Promise<{ id: string; version: number }> {
  const p = parseMemberBody(MemberTypePatchBody, input);
  const { trx } = tx;
  await lockTypeRow(trx, id);
  const before = await trx.selectFrom('member_types').selectAll().where('id', '=', id).executeTakeFirst();
  if (before === undefined) throw memberTypeNotFound();
  if (Number(before.version) !== p.version) throw memberTypeStale();

  const set: Updateable<DB['member_types']> = {};
  const fields: string[] = [];
  const change = <K extends keyof Updateable<DB['member_types']>>(field: string, column: K, next: Updateable<DB['member_types']>[K] | undefined, old: unknown): void => {
    if (next === undefined || next === old) return;
    set[column] = next;
    fields.push(field);
  };
  if (p.code !== undefined) {
    const key = codeKey(p.code);
    if (key !== before.code_key && (await keyTaken(trx, key, id))) throw memberValidationFailed([{ path: 'code', code: 'taken' }]);
    if (p.code !== before.code_display) {
      set.code_display = p.code;
      set.code_key = key;
      fields.push('code');
    }
  }
  change('nameId', 'name_id', p.nameId, before.name_id);
  change('nameEn', 'name_en', p.nameEn, before.name_en);
  change('accredGroup', 'accred_group', p.accredGroup, before.accred_group);
  change('membershipDays', 'membership_days', p.membershipDays, before.membership_days === null ? null : Number(before.membership_days));
  change('loanLimit', 'loan_limit', p.loanLimit, before.loan_limit === null ? null : Number(before.loan_limit));
  change('holdsAllowed', 'holds_allowed', p.holdsAllowed === undefined ? undefined : flag(p.holdsAllowed), Number(before.holds_allowed));
  change('holdsLimit', 'holds_limit', p.holdsLimit, Number(before.holds_limit));
  change('onlineRenewal', 'online_renewal', p.onlineRenewal === undefined ? undefined : flag(p.onlineRenewal), Number(before.online_renewal));
  change('sortOrder', 'sort_order', p.sortOrder, Number(before.sort_order));

  const updated = await takenOnRace('code', () =>
    trx
      .updateTable('member_types')
      .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw memberTypeStale();
  await tx.audit({ action: 'members.type.update', entity: 'member_types', entityId: id, meta: { fields } });
  return { id, version: p.version + 1 };
}

/**
 * Archives a member type that no live member has (`archived_at = now`, `version` + 1) and audits `members.type.archive`.
 * One already archived is answered as it is (`meta.alreadyArchived`).
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; MEMBER_TYPE_IN_USE `{count}`
 */
export async function archiveMemberType(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  await lockTypeRow(trx, id);
  const before = await trx.selectFrom('member_types').select(['archived_at', 'version']).where('id', '=', id).executeTakeFirst();
  if (before === undefined) throw memberTypeNotFound();
  if (Number(before.version) !== version) throw memberTypeStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'members.type.archive', entity: 'member_types', entityId: id, meta: { alreadyArchived: true } });
    return { id, version };
  }
  const count = await countRows(trx.selectFrom('members').select('id').where('member_type_id', '=', id).where('archived_at', 'is', null).where('anonymized_at', 'is', null));
  if (count > 0) {
    throw new DomainError('MEMBER_TYPE_IN_USE', {
      detail: `Tipe anggota ini masih dipakai ${count} anggota aktif / This member type is still used by ${count} live member(s)`,
      meta: { count },
    });
  }
  const updated = await trx
    .updateTable('member_types')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberTypeStale();
  await tx.audit({ action: 'members.type.archive', entity: 'member_types', entityId: id, meta: {} });
  return { id, version: version + 1 };
}

/**
 * Locks the member type `id` with a write that changes nothing and matches only a live type; whether it matched. A
 * member's create and type change take it, so they serialise with the type's archive (which counts live members).
 */
export async function lockLiveMemberType(trx: Transaction<DB>, id: string): Promise<boolean> {
  const locked = await trx
    .updateTable('member_types')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1;
}
