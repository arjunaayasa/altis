import type { DB } from '@altis/db';
import { DomainError, addDays, newId, type MemberBulkRefusal, type MemberEventType } from '@altis/shared';
import { MEMBER_CLASS_MOVE_MAX, MemberBulkBody, type MemberBulkRefused, type MemberBulkResponse } from '@altis/shared/api/member-ops';
import type { Selectable, Transaction, Updateable } from 'kysely';
import { closeMemberHolds } from '../../circulation/holds.js';
import type { TxCtx } from '../../context.js';
import { revokeMemberSessions } from '../area/sessions.js';
import { libraryToday, memberNotFound, memberStale, memberValidationFailed, openLoanCount, parseMemberBody, textOrNull } from '../common.js';
import { lockLiveMemberType } from '../types.js';
import { memberBalanceMinor } from './hooks.js';

// Restoring an archived member, and the bulk actions of the member list (one transaction, one audit entry).
//
// - Every member is locked with a write that changes nothing as the transaction's first statements (a member type
//   named by `set` is locked before, being a master row, which comes first in the lock order), in id order, matching
//   only live members (archived ones for a restore); the rest is decided on the latest commit.
// - Each member is either changed, or refused with a reason (MEMBER_BULK_REFUSALS); the others go on. Every change
//   writes the member's history like the single action, with field names only.
// - The class promotion reads every pair's members first and moves them all at once, so `VII-A → VIII-A` and
//   `VIII-A → IX-A` in one request move each class one step, never two.

type MemberRow = Selectable<DB['members']>;

/** Ids per statement (well below every engine's parameter limit). */
const CHUNK = 200;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Locks the members `ids` (live, or archived for a restore) in id order; answers the rows that matched. */
async function lockMembers(trx: Transaction<DB>, ids: readonly string[], archived: boolean): Promise<Map<string, MemberRow>> {
  const sorted = [...new Set(ids)].sort();
  for (const part of chunks(sorted)) {
    let q = trx
      .updateTable('members')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', 'in', part)
      .where('anonymized_at', 'is', null);
    q = archived ? q.where('archived_at', 'is not', null) : q.where('archived_at', 'is', null);
    await q.execute();
  }
  const rows = new Map<string, MemberRow>();
  for (const part of chunks(sorted)) {
    let q = trx.selectFrom('members').selectAll().where('id', 'in', part).where('anonymized_at', 'is', null);
    q = archived ? q.where('archived_at', 'is not', null) : q.where('archived_at', 'is', null);
    for (const r of await q.execute()) rows.set(r.id, r);
  }
  return rows;
}

/** Why an id that did not lock is refused: gone, or not live (archived/anonymised; for a restore: not archived). */
async function missingReason(trx: Transaction<DB>, ids: readonly string[], restore: boolean): Promise<Map<string, MemberBulkRefusal>> {
  const out = new Map<string, MemberBulkRefusal>();
  for (const part of chunks(ids)) {
    const rows = await trx.selectFrom('members').select(['id', 'archived_at', 'anonymized_at']).where('id', 'in', part).execute();
    const seen = new Map(rows.map((r) => [r.id, r]));
    for (const id of part) {
      const r = seen.get(id);
      out.set(id, r === undefined ? 'not_found' : restore && r.anonymized_at === null ? 'not_archived' : 'not_live');
    }
  }
  return out;
}

/** Updates one member (version + 1) and writes its history rows. */
async function apply(tx: TxCtx, row: MemberRow, set: Updateable<DB['members']>, events: { type: MemberEventType; meta: Record<string, unknown> }[]): Promise<void> {
  const updated = await tx.trx
    .updateTable('members')
    .set((eb) => ({ ...set, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', row.id)
    .where('version', '=', Number(row.version))
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();
  for (const e of events) {
    await tx.trx
      .insertInto('member_events')
      .values({ id: newId(tx.now), member_id: row.id, at: tx.now, type: e.type, actor_type: tx.actor.type, actor_id: tx.actor.id, meta: JSON.stringify(e.meta) })
      .execute();
  }
}

/**
 * Restores the archived member `id` (`archived_at` cleared, version + 1), history `restored`, audit
 * `members.member.restore`. An anonymised member is never restored.
 *
 * @throws DomainError NOT_FOUND (none, not archived, or anonymised); CONFLICT_STALE
 */
export async function restoreMember(tx: TxCtx, id: string, version: number): Promise<{ id: string; version: number }> {
  const rows = await lockMembers(tx.trx, [id], true);
  const row = rows.get(id);
  if (row === undefined) throw memberNotFound();
  if (Number(row.version) !== version) throw memberStale();
  await apply(tx, row, { archived_at: null }, [{ type: 'restored', meta: {} }]);
  await tx.audit({ action: 'members.member.restore', entity: 'members', entityId: id, meta: {} });
  return { id, version: version + 1 };
}

/**
 * Runs a bulk action (see the top of this file and MemberBulkBody). Audit `members.member.bulk_update` with the
 * action, the count changed and the count refused.
 *
 * @throws DomainError VALIDATION_FAILED (the body; `classMap` `too_big` when the promotion would move more than
 *   MEMBER_CLASS_MOVE_MAX members; `set.statusNote` `required` for a suspension without one)
 */
export async function bulkMembers(tx: TxCtx, input: MemberBulkBody): Promise<MemberBulkResponse> {
  const b = parseMemberBody(MemberBulkBody, input);
  const { trx } = tx;
  const refused: MemberBulkRefused[] = [];
  let done = 0;

  if (b.action === 'promote') {
    const pairs = b.classMap!;
    // Read every pair's live members first, then move them all (one step per class).
    const moves: { id: string; to: string | null }[] = [];
    for (const pair of pairs) {
      const rows = await trx
        .selectFrom('members')
        .select('id')
        .where('class_name', '=', pair.from)
        .where('archived_at', 'is', null)
        .where('anonymized_at', 'is', null)
        .execute();
      for (const r of rows) moves.push({ id: r.id, to: textOrNull(pair.to) });
      if (moves.length > MEMBER_CLASS_MOVE_MAX) throw memberValidationFailed([{ path: 'classMap', code: 'too_big' }]);
    }
    const locked = await lockMembers(trx, moves.map((m) => m.id), false);
    for (const m of moves) {
      const row = locked.get(m.id);
      if (row === undefined) continue; // archived meanwhile: no longer in the class's live members
      if (row.class_name === m.to) continue;
      await apply(tx, row, { class_name: m.to }, [{ type: 'updated', meta: { fields: ['className'] } }]);
      done += 1;
    }
    await tx.audit({ action: 'members.member.bulk_update', entity: 'members', entityId: null, meta: { action: 'promote', count: done, refused: 0, pairs: pairs.length } });
    return { done, refused };
  }

  const ids = [...new Set(b.ids!)];
  const restore = b.action === 'restore';

  // `set`: the target type (a master row) is locked before the members.
  let typeOk = true;
  let branchOk = true;
  if (b.action === 'set') {
    const s = b.set!;
    if (s.memberTypeId !== undefined) typeOk = await lockLiveMemberType(trx, s.memberTypeId);
    if (s.homeBranchId !== undefined && s.homeBranchId !== null) {
      const branch = await trx.selectFrom('branches').select('archived_at').where('id', '=', s.homeBranchId).executeTakeFirst();
      branchOk = branch !== undefined && branch.archived_at === null;
    }
    if (s.status === 'suspended' && (s.statusNote === undefined || s.statusNote === null || s.statusNote.trim() === '')) {
      throw memberValidationFailed([{ path: 'set.statusNote', code: 'required' }]);
    }
  }

  const locked = await lockMembers(trx, ids, restore);
  const missing = await missingReason(
    trx,
    ids.filter((id) => !locked.has(id)),
    restore,
  );
  for (const [id, reason] of missing) refused.push({ id, reason });

  const today = await libraryToday(trx, tx.now);
  const typeDays = new Map<string, number | null>();
  if (b.action === 'extend') {
    const typeIds = [...new Set([...locked.values()].map((r) => r.member_type_id))];
    if (typeIds.length > 0) {
      for (const t of await trx.selectFrom('member_types').select(['id', 'membership_days']).where('id', 'in', typeIds).execute()) {
        typeDays.set(t.id, t.membership_days === null ? null : Number(t.membership_days));
      }
    }
  }

  for (const id of [...locked.keys()].sort()) {
    const row = locked.get(id)!;
    switch (b.action) {
      case 'set': {
        const s = b.set!;
        if (!typeOk || !branchOk) {
          refused.push({ id, reason: 'invalid_target' });
          continue;
        }
        const set: Updateable<DB['members']> = {};
        const fields: string[] = [];
        if (s.memberTypeId !== undefined && s.memberTypeId !== row.member_type_id) {
          set.member_type_id = s.memberTypeId;
          fields.push('memberTypeId');
        }
        if (s.className !== undefined && textOrNull(s.className) !== row.class_name) {
          set.class_name = textOrNull(s.className);
          fields.push('className');
        }
        if (s.homeBranchId !== undefined && s.homeBranchId !== row.home_branch_id) {
          set.home_branch_id = s.homeBranchId;
          fields.push('homeBranchId');
        }
        const events: { type: MemberEventType; meta: Record<string, unknown> }[] = [];
        if (s.status !== undefined && s.status !== row.status) {
          set.status = s.status;
          set.status_note = s.status === 'suspended' ? textOrNull(s.statusNote) : null;
          events.push({ type: s.status === 'suspended' ? 'suspended' : 'reactivated', meta: { fields: ['status'] } });
        }
        if (fields.length > 0) events.unshift({ type: 'updated', meta: { fields: fields.sort() } });
        if (events.length === 0) continue;
        await apply(tx, row, set, events);
        done += 1;
        break;
      }
      case 'extend': {
        const start = b.from === 'today' ? today : b.from === 'expiry' ? (row.expires_on !== null && row.expires_on >= today ? row.expires_on : today) : b.from!;
        const days = b.days ?? typeDays.get(row.member_type_id) ?? null;
        if (days === null) {
          refused.push({ id, reason: 'no_days' });
          continue;
        }
        const expiresOn = addDays(start, days);
        await apply(tx, row, { valid_from: start, expires_on: expiresOn }, [{ type: 'extended', meta: { from: row.expires_on, to: expiresOn } }]);
        done += 1;
        break;
      }
      case 'archive': {
        if ((await openLoanCount(trx, id)) > 0 || (await memberBalanceMinor(trx, id)) > 0) {
          refused.push({ id, reason: 'in_use' });
          continue;
        }
        await apply(tx, row, { archived_at: tx.now }, [{ type: 'archived', meta: {} }]);
        // As the single archive: the member's active holds are cancelled (a kept copy goes to the next in its queue)
        // and the member's OPAC sessions end.
        await closeMemberHolds(tx, id);
        await revokeMemberSessions(trx, id);
        done += 1;
        break;
      }
      case 'restore': {
        await apply(tx, row, { archived_at: null }, [{ type: 'restored', meta: {} }]);
        done += 1;
        break;
      }
    }
  }
  await tx.audit({ action: 'members.member.bulk_update', entity: 'members', entityId: null, meta: { action: b.action, count: done, refused: refused.length } });
  return { done, refused };
}

/** A member refused for being in use, as the single archive answers it (used by the anonymisation). */
export function memberInUse(openLoans: number, balanceMinor: number): DomainError {
  return new DomainError('MEMBER_IN_USE', {
    detail: 'Anggota ini masih punya pinjaman atau tanggungan / This member still has loans or an unpaid balance',
    meta: { openLoans, balanceMinor },
  });
}
