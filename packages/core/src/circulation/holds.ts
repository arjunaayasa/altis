import { countRows, fullTextFamily, type DB } from '@altis/db';
import { DomainError, isDomainError, isUlid, newId, type HoldCloseReason, type HoldRefusal, type HoldSource, type HoldStatus } from '@altis/shared';
import type { HoldActionResponse, HoldCreateResponse, HoldListQuery, HoldListResponse, HoldShelfResponse, HoldView, ReturnHoldTrap } from '@altis/shared/api/holds';
import type { Selectable, Transaction } from 'kysely';
import { barcodeProblem, normalizeBarcode } from '../catalog/lib/barcode.js';
import type { TxCtx } from '../context.js';
import { lockLiveMember, memberNotFound, memberValidationFailed, type Db } from '../members/common.js';
import { indexRecords } from '../search/index-records.js';
import { readSettings } from '../settings/service.js';
import { branchToday, dueDateFor } from './dates.js';

// Holds and the hold shelf (rak tunggu).
//
// A hold is on a title (a record), queued per record and pickup branch in the order (`placed_at`, `id`); it may be
// pinned to one copy. While it is `waiting` or `ready`, `active_key = <member>:<record>` (unique: one active hold per
// member per title); while it is `ready`, `trap_item_id` names the copy kept on the hold shelf (unique: a copy is kept
// for one hold). The transitions:
//
//   (new) → waiting                  placeHold (desk, OPAC, migration)
//   waiting → ready                  a copy is returned at its own branch (trapOnReturn), staff scan a copy on the
//                                    shelf (markHoldReady), or a kept copy is let go by another hold (expiry, cancel)
//   ready → waiting                  the kept copy changes status, is archived or is lent to someone else by force
//                                    (returnKeptHoldsToQueue): the hold keeps its place in the queue
//   waiting, ready → fulfilled       the member borrows a copy of the title (fulfilHoldOnLoan)
//   waiting, ready → cancelled       the member or staff cancel it (cancelHold), the member is archived
//   ready → expired                  the pickup deadline passed (holds-job.ts); the copy goes to the next in the queue,
//                                    else it is listed to go back to the shelf until staff clear it
//   waiting → expired                its own end date (`expires_on`) passed
//
// Locks. The record is the mutex of its queue: every writer of a hold locks the hold's record first (a write that
// changes nothing), in the global order item, record, member, so a hold placed while the last copy is returned, two
// desks, two OPAC tabs or the expiry job never interleave on one title. placeHold locks the record, then the member
// (whose lock also serialises a member's holds against the limit). A route that names a hold by id reads the hold with
// a locking read first (to learn its record and copy), then locks the copy, the record and the member: the one known
// exception to the order, like a loan named by id. Each write of a hold's status is conditional on the status read
// (`WHERE id = ? AND status = :read`).
//
// Dates (placed on, pickup deadline) are the pickup branch's calendar dates; the pickup deadline is counted like a due
// date (dates.ts dueDateFor), so a library calendar moves it off closed days once one is plugged in there.

type HoldRow = Selectable<DB['holds']>;

/** The item statuses of a copy a hold may wait for (it may circulate once it is on the shelf). */
const HOLDABLE_STATUSES = ['available', 'on_order', 'processing', 'repair'] as const;

/** The widest `active_key`: `<26>:<26>`. */
const activeKey = (memberId: string, recordId: string): string => `${memberId}:${recordId}`;

const ok = (n: number | string | bigint): number => Number(n);

/** What happens when a hold becomes `ready`: the notices seam (the hold-ready e-mail is queued by a registered hook). */
export type HoldReadyHook = (tx: TxCtx, hold: { id: string; memberId: string; recordId: string; readyAt: number; pickupUntil: string }) => Promise<void>;

/**
 * The hooks called in the transaction that makes a hold `ready` (after its row is written). Empty here; the notices
 * module appends the hook that queues the "hold ready" e-mail.
 */
export const HOLD_READY_HOOKS: HoldReadyHook[] = [];

// ---- errors ----------------------------------------------------------------------------------------------------------

const REFUSAL_TEXT: Record<HoldRefusal, string> = {
  disabled: 'Reservasi sedang tidak dibuka / Holds are not open',
  member: 'Keanggotaan tidak aktif atau sudah habis / The membership is not active or has expired',
  not_allowed: 'Tipe anggota ini tidak boleh memesan / This member type may not place holds',
  limit: 'Batas jumlah reservasi tercapai / The hold limit is reached',
  duplicate: 'Anggota ini sudah memesan judul ini / This member already holds this title',
  own_loan: 'Anggota ini sedang meminjam judul ini / This member has this title on loan',
  no_copies: 'Tidak ada eksemplar yang bisa dipinjam di cabang ini / No copy at this branch may be lent',
  available: 'Ada eksemplar yang tersedia di rak / A copy is on the shelf now',
  closed: 'Reservasi ini sudah selesai / This hold is no longer active',
  not_on_shelf: 'Tidak ada eksemplar reservasi ini yang perlu dikembalikan ke rak / No copy of this hold has to go back to the shelf',
};

export function holdRefused(reason: HoldRefusal): DomainError {
  return new DomainError('CIRC_HOLD_REFUSED', { detail: REFUSAL_TEXT[reason], meta: { reason } });
}

function holdNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Reservasi tidak ditemukan / Hold not found' });
}

function recordNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Cantuman tidak ditemukan / Record not found' });
}

function itemOnHold(holdId: string): DomainError {
  return new DomainError('CIRC_ITEM_ON_HOLD', {
    detail: 'Eksemplar ini ditahan di rak tunggu untuk anggota lain / This item is kept on the hold shelf for another member',
    meta: { holdId },
  });
}

// ---- settings --------------------------------------------------------------------------------------------------------

/** The hold settings (`circulation.holds.*`). */
export interface HoldSettings {
  enabled: boolean;
  opac: boolean;
  onlyWhenNoneAvailable: boolean;
  pickupDays: number;
}

const SETTING_KEYS = ['circulation.holds.enabled', 'circulation.holds.opac', 'circulation.holds.onlyWhenNoneAvailable', 'circulation.holds.pickupDays'] as const;

export async function holdSettings(db: Db): Promise<HoldSettings> {
  const s = await readSettings(db, SETTING_KEYS, []);
  return {
    enabled: s['circulation.holds.enabled'] === true,
    opac: s['circulation.holds.opac'] === true,
    onlyWhenNoneAvailable: s['circulation.holds.onlyWhenNoneAvailable'] === true,
    pickupDays: Number(s['circulation.holds.pickupDays']),
  };
}

// ---- locks -----------------------------------------------------------------------------------------------------------

/** Whether the connection supports `FOR UPDATE` (SQLite has one writer and none). */
function locking(trx: Transaction<DB>): boolean {
  return fullTextFamily(trx) !== 'fts5';
}

/** Locks a live record that was not merged away; whether it matched. */
async function lockLiveRecord(trx: Transaction<DB>, id: string): Promise<boolean> {
  const r = await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .where('merged_into', 'is', null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

async function lockRecordRow(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

async function lockItemRow(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('items')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

async function lockMemberRow(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/** A locking read of the hold `id` (what its writer must lock next), or null. */
async function lockHold(trx: Transaction<DB>, id: string): Promise<Pick<HoldRow, 'id' | 'record_id' | 'trap_item_id' | 'member_id' | 'pickup_branch_id'> | null> {
  const q = trx.selectFrom('holds').select(['id', 'record_id', 'trap_item_id', 'member_id', 'pickup_branch_id']).where('id', '=', id);
  return (await (locking(trx) ? q.forUpdate() : q).executeTakeFirst()) ?? null;
}

/**
 * The locks of a write to the hold `id` named by id: the hold (locking read), its kept copy, its record, its member.
 * The hold as it is after them, or null when there is none.
 */
async function lockHoldForWrite(trx: Transaction<DB>, id: string): Promise<HoldRow | null> {
  const lock = await lockHold(trx, id);
  if (lock === null) return null;
  if (lock.trap_item_id !== null) await lockItemRow(trx, lock.trap_item_id);
  await lockRecordRow(trx, lock.record_id);
  if (lock.member_id !== null) await lockMemberRow(trx, lock.member_id);
  return (await trx.selectFrom('holds').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
}

// ---- small reads -----------------------------------------------------------------------------------------------------

/** The staff user acting, or null (a member or the system). */
function staffOf(tx: TxCtx): string | null {
  return tx.actor.type === 'staff' ? tx.actor.id : null;
}

/** The place of the waiting hold `h` in its queue (1 = next). */
async function positionOf(db: Db, h: Pick<HoldRow, 'id' | 'record_id' | 'pickup_branch_id' | 'placed_at'>): Promise<number> {
  const before = await countRows(
    db
      .selectFrom('holds')
      .select('id')
      .where('record_id', '=', h.record_id)
      .where('pickup_branch_id', '=', h.pickup_branch_id)
      .where('status', '=', 'waiting')
      .where((eb) => eb.or([eb('placed_at', '<', h.placed_at), eb.and([eb('placed_at', '=', h.placed_at), eb('id', '<', h.id)])])),
  );
  return before + 1;
}

/** The pickup deadline of a copy kept today at `branchId`. */
async function pickupDeadline(db: Db, branchId: string, now: number): Promise<string> {
  const { pickupDays } = await holdSettings(db);
  const today = await branchToday(db, branchId, now);
  return (await dueDateFor(db, { loanedOn: today, days: pickupDays, expiresOn: null, branchId })).dueOn;
}

/** The kept copy of an item's hold, if any: the hold's id and member. */
async function keptFor(db: Db, itemId: string): Promise<{ id: string; member_id: string | null } | null> {
  return (await db.selectFrom('holds').select(['id', 'member_id']).where('trap_item_id', '=', itemId).executeTakeFirst()) ?? null;
}

/**
 * The branch a member's OPAC hold is picked up at: the member's home branch while it is live, else the library's
 * default branch, else the first live branch by code.
 *
 * @throws DomainError NOT_FOUND when the library has no live branch
 */
export async function pickupBranchFor(db: Db, memberId: string): Promise<string> {
  const m = await db.selectFrom('members').select('home_branch_id').where('id', '=', memberId).executeTakeFirst();
  if (m?.home_branch_id !== null && m?.home_branch_id !== undefined) {
    const home = await db.selectFrom('branches').select('id').where('id', '=', m.home_branch_id).where('archived_at', 'is', null).executeTakeFirst();
    if (home !== undefined) return home.id;
  }
  const b = await db.selectFrom('branches').select('id').where('archived_at', 'is', null).orderBy('is_default', 'desc').orderBy('code_key').executeTakeFirst();
  if (b === undefined) throw new DomainError('NOT_FOUND', { detail: 'Tidak ada cabang / No branch' });
  return b.id;
}

// ---- trap: keep a copy for the next in the queue ------------------------------------------------------------------------

/**
 * Keeps the copy `itemId` for the first waiting hold of its title at the copy's branch (a hold pinned to another copy
 * is passed over), when the copy is live, `available`, of a collection type that may be lent, not on loan and not kept
 * already. Run under the record lock of the copy's title. The hold becomes `ready` with its pickup deadline; the hooks
 * of {@link HOLD_READY_HOOKS} run. What the desk tells the staff, or null when no hold takes the copy.
 */
async function keepForNext(tx: TxCtx, itemId: string): Promise<ReturnHoldTrap | null> {
  const { trx } = tx;
  const item = await trx
    .selectFrom('items as i')
    .leftJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .select(['i.id', 'i.record_id', 'i.branch_id', 'i.status', 'i.archived_at', 'ct.loanable'])
    .where('i.id', '=', itemId)
    .executeTakeFirst();
  if (item === undefined || item.archived_at !== null || item.status !== 'available') return null;
  if (item.loanable !== null && Number(item.loanable) !== 1) return null;
  if ((await trx.selectFrom('loans').select('id').where('open_item_id', '=', itemId).executeTakeFirst()) !== undefined) return null;
  if ((await keptFor(trx, itemId)) !== null) return null;
  const next = await trx
    .selectFrom('holds')
    .selectAll()
    .where('record_id', '=', item.record_id)
    .where('pickup_branch_id', '=', item.branch_id)
    .where('status', '=', 'waiting')
    .where('member_id', 'is not', null)
    .where((eb) => eb.or([eb('pinned', '=', 0), eb('item_id', '=', itemId)]))
    .orderBy('placed_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (next === undefined || next.member_id === null) return null;
  const pickupUntil = await pickupDeadline(trx, item.branch_id, tx.now);
  const updated = await trx
    .updateTable('holds')
    .set((eb) => ({
      status: 'ready',
      item_id: itemId,
      trap_item_id: itemId,
      ready_at: tx.now,
      pickup_until: pickupUntil,
      updated_at: tx.now,
      updated_by: staffOf(tx),
      version: eb('version', '+', 1),
    }))
    .where('id', '=', next.id)
    .where('status', '=', 'waiting')
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) return null;
  for (const hook of HOLD_READY_HOOKS) {
    await hook(tx, { id: next.id, memberId: next.member_id, recordId: next.record_id, readyAt: tx.now, pickupUntil });
  }
  const m = await trx.selectFrom('members').select(['member_no_display', 'name']).where('id', '=', next.member_id).executeTakeFirst();
  return { holdId: next.id, memberId: next.member_id, memberNo: m?.member_no_display ?? '', memberName: m?.name ?? '', pickupUntil };
}

/**
 * The desk's return, after the loan of `itemId` was closed at `returnBranchId` (under the item, record and member locks
 * of the return): the copy is kept for the first in its queue when it was returned at its own branch (a copy returned
 * elsewhere goes home first). Who it is kept for, or null.
 */
export async function trapOnReturn(tx: TxCtx, input: { itemId: string; returnBranchId: string }): Promise<ReturnHoldTrap | null> {
  const item = await tx.trx.selectFrom('items').select('branch_id').where('id', '=', input.itemId).executeTakeFirst();
  if (item === undefined || item.branch_id !== input.returnBranchId) return null;
  return keepForNext(tx, input.itemId);
}

/**
 * Lets go of the copy a closed hold kept: it goes to the next in the queue (the closed hold is then cleared from the
 * shelf, as the copy stays there), else it waits on the "back to the shelf" list.
 */
async function releaseKeptCopy(tx: TxCtx, closed: { id: string }, itemId: string): Promise<ReturnHoldTrap | null> {
  const next = await keepForNext(tx, itemId);
  if (next !== null) {
    await tx.trx.updateTable('holds').set({ shelf_cleared_at: tx.now }).where('id', '=', closed.id).where('shelf_cleared_at', 'is', null).execute();
  }
  return next;
}

/** Closes the active hold `h` (status as read) with `status` and `reason`; whether the conditional write matched. */
async function closeHold(tx: TxCtx, h: Pick<HoldRow, 'id' | 'status'>, status: Extract<HoldStatus, 'fulfilled' | 'cancelled' | 'expired'>, reason: HoldCloseReason, loanId: string | null = null): Promise<boolean> {
  const r = await tx.trx
    .updateTable('holds')
    .set((eb) => ({
      status,
      close_reason: reason,
      closed_at: tx.now,
      active_key: null,
      trap_item_id: null,
      loan_id: loanId,
      updated_at: tx.now,
      updated_by: staffOf(tx),
      version: eb('version', '+', 1),
    }))
    .where('id', '=', h.id)
    .where('status', '=', h.status)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

// ---- place -----------------------------------------------------------------------------------------------------------

/** What a new hold needs. */
export interface PlaceHoldInput {
  memberId: string;
  recordId: string;
  /** The copy the hold is pinned to: a copy of the record at the pickup branch. */
  itemId?: string | undefined;
  /** The pickup branch: the desk's own; for the OPAC, {@link pickupBranchFor}. */
  pickupBranchId: string;
  source: Exclude<HoldSource, 'migrated'>;
  /** Place it although a copy is on the shelf now (a desk override); default false. */
  allowAvailable?: boolean;
}

/**
 * Places a hold (see the top of this file) and audits `circulation.hold.create` (actor: the staff user, or the member
 * for an OPAC hold). The record is locked first, then the member; then, in order: holds are open (`disabled`; an OPAC
 * hold also needs `circulation.holds.opac`), the member is active and not expired at the pickup branch (`member`), the
 * type may hold (`not_allowed`), the member is under the type's `holds_limit` (`limit`), holds no active hold on the
 * title (`duplicate`, guaranteed by `active_key`), has no copy of it on loan (`own_loan`), the title has a copy that may
 * be lent at the pickup branch (`no_copies`), and with `circulation.holds.onlyWhenNoneAvailable` none of them (or the
 * pinned one) is on the shelf now (`available`).
 *
 * @throws DomainError NOT_FOUND (a record not live or merged; a member not live); VALIDATION_FAILED `{path: 'itemId',
 *   code: 'invalid'}`; CIRC_HOLD_REFUSED `{reason}`
 */
export async function placeHold(tx: TxCtx, input: PlaceHoldInput): Promise<HoldCreateResponse> {
  const { trx } = tx;
  if (!(await lockLiveRecord(trx, input.recordId))) throw recordNotFound();
  if (!(await lockLiveMember(trx, input.memberId))) throw memberNotFound();

  const settings = await holdSettings(trx);
  if (!settings.enabled || (input.source === 'opac' && !settings.opac)) throw holdRefused('disabled');
  const member = await trx.selectFrom('members').select(['id', 'status', 'expires_on', 'member_type_id']).where('id', '=', input.memberId).executeTakeFirstOrThrow();
  const today = await branchToday(trx, input.pickupBranchId, tx.now);
  if (member.status === 'suspended' || (member.expires_on !== null && member.expires_on < today)) throw holdRefused('member');
  const type = await trx.selectFrom('member_types').select(['holds_allowed', 'holds_limit']).where('id', '=', member.member_type_id).executeTakeFirst();
  if (type !== undefined && Number(type.holds_allowed) !== 1) throw holdRefused('not_allowed');
  const active = await countRows(trx.selectFrom('holds').select('id').where('member_id', '=', member.id).where('status', 'in', ['waiting', 'ready']));
  if (type !== undefined && active >= ok(type.holds_limit)) throw holdRefused('limit');
  const key = activeKey(member.id, input.recordId);
  if ((await trx.selectFrom('holds').select('id').where('active_key', '=', key).executeTakeFirst()) !== undefined) throw holdRefused('duplicate');
  const ownLoan = await trx
    .selectFrom('loans as l')
    .innerJoin('items as i', 'i.id', 'l.open_item_id')
    .select('l.id')
    .where('l.member_id', '=', member.id)
    .where('i.record_id', '=', input.recordId)
    .executeTakeFirst();
  if (ownLoan !== undefined) throw holdRefused('own_loan');

  // The copies of the title at the pickup branch that may circulate.
  const copies = await trx
    .selectFrom('items as i')
    .leftJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .select(['i.id', 'i.status', 'ct.loanable'])
    .where('i.record_id', '=', input.recordId)
    .where('i.branch_id', '=', input.pickupBranchId)
    .where('i.archived_at', 'is', null)
    .where('i.status', 'in', [...HOLDABLE_STATUSES])
    .execute();
  const holdable = copies.filter((c) => c.loanable === null || Number(c.loanable) === 1);
  if (input.itemId !== undefined && !holdable.some((c) => c.id === input.itemId)) throw memberValidationFailed([{ path: 'itemId', code: 'invalid' }]);
  if (holdable.length === 0) throw holdRefused('no_copies');
  if (settings.onlyWhenNoneAvailable && input.allowAvailable !== true) {
    const shelf = holdable.filter((c) => c.status === 'available' && (input.itemId === undefined || c.id === input.itemId)).map((c) => c.id);
    if (shelf.length > 0) {
      const out = new Set((await trx.selectFrom('loans').select('open_item_id').where('open_item_id', 'in', shelf).execute()).map((r) => r.open_item_id));
      const kept = new Set((await trx.selectFrom('holds').select('trap_item_id').where('trap_item_id', 'in', shelf).execute()).map((r) => r.trap_item_id));
      if (shelf.some((id) => !out.has(id) && !kept.has(id))) throw holdRefused('available');
    }
  }

  const id = newId(tx.now);
  const staff = staffOf(tx);
  try {
    await trx
      .insertInto('holds')
      .values({
        id,
        record_id: input.recordId,
        item_id: input.itemId ?? null,
        pinned: input.itemId === undefined ? 0 : 1,
        member_id: member.id,
        pickup_branch_id: input.pickupBranchId,
        status: 'waiting',
        active_key: key,
        trap_item_id: null,
        placed_on: today,
        placed_at: tx.now,
        placed_by: input.source === 'desk' ? staff : null,
        source: input.source,
        expires_on: null,
        ready_at: null,
        pickup_until: null,
        closed_at: null,
        close_reason: null,
        shelf_cleared_at: null,
        loan_id: null,
        version: 0,
        created_at: tx.now,
        created_by: staff,
        updated_at: tx.now,
        updated_by: staff,
      })
      .execute();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw holdRefused('duplicate');
    throw error;
  }
  const position = await positionOf(trx, { id, record_id: input.recordId, pickup_branch_id: input.pickupBranchId, placed_at: tx.now });
  await tx.audit({
    action: 'circulation.hold.create',
    entity: 'holds',
    entityId: id,
    branchId: input.pickupBranchId,
    meta: { source: input.source, pinned: input.itemId !== undefined },
  });
  return { id, version: 0, status: 'waiting', position };
}

// ---- cancel, ready, clear --------------------------------------------------------------------------------------------

/** Who cancels a hold: staff at the pickup branch's desk, or the member (only their own). */
export type CancelHoldInput = { holdId: string; by: 'staff'; branchId: string } | { holdId: string; by: 'member'; memberId: string };

/**
 * Cancels an active hold (`cancelled_staff` or `cancelled_member`) and audits `circulation.hold.cancel`. A hold of
 * another member, or (staff) of another pickup branch, is NOT_FOUND. When its copy was kept, the copy goes to the next
 * in the queue, else it is listed to go back to the shelf.
 *
 * @throws DomainError NOT_FOUND; CIRC_HOLD_REFUSED `closed`
 */
export async function cancelHold(tx: TxCtx, input: CancelHoldInput): Promise<HoldActionResponse> {
  const h = await lockHoldForWrite(tx.trx, input.holdId);
  if (h === null) throw holdNotFound();
  if (input.by === 'member' ? h.member_id !== input.memberId : h.pickup_branch_id !== input.branchId) throw holdNotFound();
  if (h.status !== 'waiting' && h.status !== 'ready') throw holdRefused('closed');
  if (!(await closeHold(tx, h, 'cancelled', input.by === 'member' ? 'cancelled_member' : 'cancelled_staff'))) throw holdRefused('closed');
  if (h.trap_item_id !== null) {
    await releaseKeptCopy(tx, h, h.trap_item_id);
    await indexRecords(tx.trx, [h.record_id], tx.now);
  }
  await tx.audit({ action: 'circulation.hold.cancel', entity: 'holds', entityId: h.id, branchId: h.pickup_branch_id, meta: { by: input.by, was: h.status } });
  return { id: h.id, version: ok(h.version) + 1, status: 'cancelled', pickupUntil: null };
}

/**
 * "Tandai siap": keeps the scanned copy for the waiting hold `holdId` at its pickup branch `branchId` and audits
 * `circulation.hold.ready`. The copy must be of the hold's record (`{path: 'barcode', code: 'other_record'}`), the
 * pinned copy for a pinned hold (`{path: 'barcode', code: 'not_pinned_copy'}`), of the pickup branch
 * (CIRC_OTHER_BRANCH), `available` (CIRC_NOT_LOANABLE `status`), not on loan (CIRC_ITEM_ON_LOAN) and not kept for
 * another hold (CIRC_ITEM_ON_HOLD).
 *
 * @throws DomainError NOT_FOUND (the hold, or no live copy has the barcode); VALIDATION_FAILED; CIRC_HOLD_REFUSED
 *   `closed`; the item errors above
 */
export async function markHoldReady(tx: TxCtx, input: { holdId: string; branchId: string; barcode: string }): Promise<HoldActionResponse> {
  const { trx } = tx;
  const lock = await lockHold(trx, input.holdId);
  if (lock === null || lock.pickup_branch_id !== input.branchId) throw holdNotFound();
  const key = normalizeBarcode(input.barcode);
  const problem = barcodeProblem(key);
  if (problem === 'isbn_not_barcode') throw memberValidationFailed([{ path: 'barcode', code: 'isbn_not_barcode' }]);
  const q = trx.selectFrom('items').select(['id', 'record_id', 'branch_id', 'status']).where('barcode_key', '=', key).where('archived_at', 'is', null);
  const item = problem !== null ? undefined : await (locking(trx) ? q.forUpdate() : q).executeTakeFirst();
  await lockRecordRow(trx, lock.record_id);
  if (lock.member_id !== null) await lockMemberRow(trx, lock.member_id);
  if (item === undefined) throw new DomainError('NOT_FOUND', { detail: 'Eksemplar tidak ditemukan / Item not found' });

  const h = await trx.selectFrom('holds').selectAll().where('id', '=', input.holdId).executeTakeFirstOrThrow();
  if (h.status !== 'waiting') throw holdRefused('closed');
  if (item.record_id !== h.record_id) throw memberValidationFailed([{ path: 'barcode', code: 'other_record' }]);
  if (Number(h.pinned) === 1 && h.item_id !== item.id) throw memberValidationFailed([{ path: 'barcode', code: 'not_pinned_copy' }]);
  if (item.branch_id !== h.pickup_branch_id) {
    const b = await trx.selectFrom('branches').select('code_display').where('id', '=', item.branch_id).executeTakeFirst();
    const branchCode = b?.code_display ?? '?';
    throw new DomainError('CIRC_OTHER_BRANCH', { detail: `Eksemplar ini milik cabang ${branchCode} / This item belongs to branch ${branchCode}`, meta: { branchCode } });
  }
  if (item.status !== 'available') {
    throw new DomainError('CIRC_NOT_LOANABLE', { detail: 'Status eksemplar tidak memungkinkan / The item status does not allow it', meta: { reason: 'status', status: item.status } });
  }
  if ((await trx.selectFrom('loans').select('id').where('open_item_id', '=', item.id).executeTakeFirst()) !== undefined) {
    throw new DomainError('CIRC_ITEM_ON_LOAN', { detail: 'Eksemplar ini sedang dipinjam / This item is on loan', meta: { sameMember: false, reason: 'other_member' } });
  }
  const kept = await keptFor(trx, item.id);
  if (kept !== null) throw itemOnHold(kept.id);

  const pickupUntil = await pickupDeadline(trx, h.pickup_branch_id, tx.now);
  const updated = await trx
    .updateTable('holds')
    .set((eb) => ({
      status: 'ready',
      item_id: item.id,
      trap_item_id: item.id,
      ready_at: tx.now,
      pickup_until: pickupUntil,
      updated_at: tx.now,
      updated_by: staffOf(tx),
      version: eb('version', '+', 1),
    }))
    .where('id', '=', h.id)
    .where('status', '=', 'waiting')
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw holdRefused('closed');
  if (h.member_id !== null) {
    for (const hook of HOLD_READY_HOOKS) await hook(tx, { id: h.id, memberId: h.member_id, recordId: h.record_id, readyAt: tx.now, pickupUntil });
  }
  await indexRecords(trx, [h.record_id], tx.now);
  await tx.audit({ action: 'circulation.hold.ready', entity: 'holds', entityId: h.id, branchId: h.pickup_branch_id, meta: {} });
  return { id: h.id, version: ok(h.version) + 1, status: 'ready', pickupUntil };
}

/**
 * "Bereskan": the copy of a hold that expired or was cancelled while its copy was kept is back on the shelf
 * (`shelf_cleared_at`); audits `circulation.hold.shelf_clear`.
 *
 * @throws DomainError NOT_FOUND (none, or another pickup branch); CIRC_HOLD_REFUSED `not_on_shelf`
 */
export async function clearHoldShelf(tx: TxCtx, input: { holdId: string; branchId: string }): Promise<HoldActionResponse> {
  const lock = await lockHold(tx.trx, input.holdId);
  if (lock === null || lock.pickup_branch_id !== input.branchId) throw holdNotFound();
  const h = await tx.trx.selectFrom('holds').selectAll().where('id', '=', input.holdId).executeTakeFirstOrThrow();
  if ((h.status !== 'expired' && h.status !== 'cancelled') || h.ready_at === null || h.shelf_cleared_at !== null) throw holdRefused('not_on_shelf');
  const r = await tx.trx
    .updateTable('holds')
    .set((eb) => ({ shelf_cleared_at: tx.now, updated_at: tx.now, updated_by: staffOf(tx), version: eb('version', '+', 1) }))
    .where('id', '=', h.id)
    .where('shelf_cleared_at', 'is', null)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw holdRefused('not_on_shelf');
  await tx.audit({ action: 'circulation.hold.shelf_clear', entity: 'holds', entityId: h.id, branchId: h.pickup_branch_id, meta: {} });
  return { id: h.id, version: ok(h.version) + 1, status: h.status as HoldStatus, pickupUntil: h.pickup_until };
}

// ---- expiry (the scheduled job) ---------------------------------------------------------------------------------------

/**
 * Expires the hold `holdId` when it is still due on the pickup branch's `today` (the job's step for one hold, in its own
 * transaction): a `ready` hold whose `pickup_until` is before today (`expired_pickup`; its copy goes to the next in the
 * queue, else to the "back to the shelf" list), or a `waiting` hold whose `expires_on` is before today (`expired_wait`).
 * What happened: `null` when the hold is no longer due (another writer got there first).
 */
export async function expireHold(tx: TxCtx, holdId: string): Promise<{ kind: 'pickup' | 'wait'; keptForNext: boolean } | null> {
  const h = await lockHoldForWrite(tx.trx, holdId);
  if (h === null) return null;
  const today = await branchToday(tx.trx, h.pickup_branch_id, tx.now);
  if (h.status === 'ready' && h.pickup_until !== null && h.pickup_until < today) {
    if (!(await closeHold(tx, h, 'expired', 'expired_pickup'))) return null;
    const next = h.trap_item_id === null ? null : await releaseKeptCopy(tx, h, h.trap_item_id);
    await indexRecords(tx.trx, [h.record_id], tx.now);
    return { kind: 'pickup', keptForNext: next !== null };
  }
  if (h.status === 'waiting' && h.expires_on !== null && h.expires_on < today) {
    if (!(await closeHold(tx, h, 'expired', 'expired_wait'))) return null;
    return { kind: 'wait', keptForNext: false };
  }
  return null;
}

/**
 * The holds due to expire at `now`, at most `limit`: per branch, `ready` holds past their pickup deadline and `waiting`
 * holds past their end date, in the branch's calendar.
 */
export async function dueHoldIds(db: Db, now: number, limit: number): Promise<string[]> {
  const branches = await db.selectFrom('branches').select('id').execute();
  const out: string[] = [];
  for (const b of branches) {
    if (out.length >= limit) break;
    const today = await branchToday(db, b.id, now);
    const rows = await db
      .selectFrom('holds')
      .select('id')
      .where('pickup_branch_id', '=', b.id)
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'ready'), eb('pickup_until', '<', today)]),
          eb.and([eb('status', '=', 'waiting'), eb('expires_on', 'is not', null), eb('expires_on', '<', today)]),
        ]),
      )
      .orderBy('id')
      .limit(limit - out.length)
      .execute();
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

// ---- the desk's lend and renew, the catalogue's item writers --------------------------------------------------------

/**
 * The lend check after "no open loan": a copy kept on the hold shelf for another member may not be lent to `memberId`.
 * With `force` (a desk override) the other member's hold goes back to waiting, keeping its place in the queue.
 *
 * @throws DomainError CIRC_ITEM_ON_HOLD `{holdId}`
 */
export async function checkKeptCopy(tx: TxCtx, input: { itemId: string; memberId: string; force?: boolean }): Promise<void> {
  const kept = await keptFor(tx.trx, input.itemId);
  if (kept === null || kept.member_id === input.memberId) return;
  if (input.force !== true) throw itemOnHold(kept.id);
  await returnKeptHoldsToQueue(tx, [input.itemId]);
}

/**
 * After a loan of `itemId` to `memberId` (under the lend's locks): the member's own active hold on the title is
 * fulfilled (`fulfilled`, `loan_id`). When that hold kept another copy, the copy goes to the next in the queue. A copy
 * that waited on the "back to the shelf" list is cleared from it. The fulfilled hold's id, or null.
 */
export async function fulfilHoldOnLoan(tx: TxCtx, input: { memberId: string; recordId: string; itemId: string; loanId: string }): Promise<string | null> {
  const { trx } = tx;
  await trx
    .updateTable('holds')
    .set({ shelf_cleared_at: tx.now })
    .where('item_id', '=', input.itemId)
    .where('status', 'in', ['expired', 'cancelled'])
    .where('ready_at', 'is not', null)
    .where('shelf_cleared_at', 'is', null)
    .execute();
  const h = await trx.selectFrom('holds').selectAll().where('active_key', '=', activeKey(input.memberId, input.recordId)).executeTakeFirst();
  if (h === undefined) return null;
  if (!(await closeHold(tx, h, 'fulfilled', 'loaned', input.loanId))) return null;
  if (h.trap_item_id !== null && h.trap_item_id !== input.itemId) await keepForNext(tx, h.trap_item_id);
  return h.id;
}

/**
 * Whether a renewal of a loan of `itemId` (title `recordId`, loan branch `branchId`) must be refused for the queue: a
 * waiting hold on the title at that branch that is not pinned to another copy.
 */
export async function renewalHeldBack(db: Db, input: { recordId: string; branchId: string; itemId: string | null }): Promise<boolean> {
  const row = await db
    .selectFrom('holds')
    .select('id')
    .where('record_id', '=', input.recordId)
    .where('pickup_branch_id', '=', input.branchId)
    .where('status', '=', 'waiting')
    .where((eb) => (input.itemId === null ? eb('pinned', '=', 0) : eb.or([eb('pinned', '=', 0), eb('item_id', '=', input.itemId)])))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The item writers' seam: the copies `itemIds` stop being kept (their status changed away from `available`, they were
 * archived, declared lost, or lent to someone else by force) and their holds go back to `waiting`, keeping their place
 * in the queue. Run in the writer's transaction, under its record locks. How many holds went back.
 */
export async function returnKeptHoldsToQueue(tx: TxCtx, itemIds: readonly string[]): Promise<number> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0) return 0;
  const rows = await tx.trx.selectFrom('holds').select(['id', 'pinned']).where('trap_item_id', 'in', unique).where('status', '=', 'ready').execute();
  let n = 0;
  for (const r of rows) {
    const pinned = Number(r.pinned) === 1;
    const u = await tx.trx
      .updateTable('holds')
      .set((eb) => ({
        status: 'waiting',
        ...(pinned ? {} : { item_id: null }),
        trap_item_id: null,
        ready_at: null,
        pickup_until: null,
        updated_at: tx.now,
        updated_by: staffOf(tx),
        version: eb('version', '+', 1),
      }))
      .where('id', '=', r.id)
      .where('status', '=', 'ready')
      .executeTakeFirst();
    n += Number(u.numUpdatedRows);
  }
  return n;
}

// ---- members: archive, anonymisation --------------------------------------------------------------------------------

/**
 * A member is archived (or anonymised): every active hold of `memberId` is cancelled (`member_archived`). Run after
 * the member's lock; the records of the member's holds are locked next, in id order (the one exception to the lock order
 * of this file, retried by withTx when it meets a deadlock). A kept copy goes to the next in its queue, else to the
 * "back to the shelf" list. How many holds were closed.
 */
export async function closeMemberHolds(tx: TxCtx, memberId: string): Promise<number> {
  const { trx } = tx;
  const rows = await trx.selectFrom('holds').selectAll().where('member_id', '=', memberId).where('status', 'in', ['waiting', 'ready']).orderBy('id').execute();
  if (rows.length === 0) return 0;
  const records = [...new Set(rows.map((r) => r.record_id))].sort();
  for (const r of records) await lockRecordRow(trx, r);
  let n = 0;
  const released: string[] = [];
  for (const h of rows) {
    if (!(await closeHold(tx, h, 'cancelled', 'member_archived'))) continue;
    n += 1;
    if (h.trap_item_id !== null) {
      await releaseKeptCopy(tx, h, h.trap_item_id);
      released.push(h.record_id);
    }
  }
  if (released.length > 0) await indexRecords(trx, [...new Set(released)], tx.now);
  return n;
}

/**
 * The automatic anonymisation of history: closed holds closed before `closedBefore` lose their member (at most `limit`
 * per call). How many were anonymised.
 */
export async function anonymizeClosedHolds(trx: Transaction<DB>, closedBefore: number, limit = 500): Promise<number> {
  const ids = (
    await trx
      .selectFrom('holds')
      .select('id')
      .where('status', 'in', ['fulfilled', 'cancelled', 'expired'])
      .where('closed_at', '<', closedBefore)
      .where('member_id', 'is not', null)
      .orderBy('id')
      .limit(limit)
      .execute()
  ).map((r) => r.id);
  if (ids.length === 0) return 0;
  const r = await trx.updateTable('holds').set({ member_id: null }).where('id', 'in', ids).where('active_key', 'is', null).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

// ---- records: merge --------------------------------------------------------------------------------------------------

/**
 * The record merge's seam (run in the merge transaction, after both records and the moved items are locked): (1) an
 * active hold on the source whose member also holds the target is cancelled (`cancelled_staff`), the newer of the two
 * going; (2) the source's other holds move to the target, with their `active_key`; (3) the source's loans move to the
 * target. No step can meet a unique key.
 */
export async function moveHoldsOnMerge(tx: TxCtx, targetId: string, sourceId: string): Promise<void> {
  const { trx } = tx;
  const source = await trx.selectFrom('holds').selectAll().where('record_id', '=', sourceId).where('status', 'in', ['waiting', 'ready']).execute();
  for (const s of source) {
    if (s.member_id === null) continue;
    const t = await trx.selectFrom('holds').selectAll().where('active_key', '=', activeKey(s.member_id, targetId)).executeTakeFirst();
    if (t === undefined) continue;
    const newer = s.placed_at > t.placed_at || (s.placed_at === t.placed_at && s.id > t.id) ? s : t;
    await closeHold(tx, newer, 'cancelled', 'cancelled_staff');
  }
  const remaining = await trx.selectFrom('holds').select(['id', 'member_id', 'active_key']).where('record_id', '=', sourceId).execute();
  for (const h of remaining) {
    await trx
      .updateTable('holds')
      .set({
        record_id: targetId,
        active_key: h.active_key === null || h.member_id === null ? null : activeKey(h.member_id, targetId),
        updated_at: tx.now,
        updated_by: staffOf(tx),
      })
      .where('id', '=', h.id)
      .execute();
  }
  await trx.updateTable('loans').set({ record_id: targetId }).where('record_id', '=', sourceId).execute();
}

// ---- availability ----------------------------------------------------------------------------------------------------

/** The copies among `itemIds` kept on a hold shelf: item id → the hold and its pickup deadline. */
export async function keptItems(db: Db, itemIds: readonly string[]): Promise<Map<string, { holdId: string; pickupUntil: string | null }>> {
  const out = new Map<string, { holdId: string; pickupUntil: string | null }>();
  const unique = [...new Set(itemIds)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .selectFrom('holds')
      .select(['id', 'trap_item_id', 'pickup_until'])
      .where('trap_item_id', 'in', unique.slice(i, i + 500))
      .execute();
    for (const r of rows) if (r.trap_item_id !== null) out.set(r.trap_item_id, { holdId: r.id, pickupUntil: r.pickup_until });
  }
  return out;
}

// ---- views -----------------------------------------------------------------------------------------------------------

/** The views of `rows`, with titles, copies, members, branches and the queue position of each waiting hold. */
async function holdViews(db: Db, rows: readonly HoldRow[]): Promise<HoldView[]> {
  if (rows.length === 0) return [];
  const ids = <T>(f: (r: HoldRow) => T | null): T[] => [...new Set(rows.map(f).filter((v): v is T => v !== null))];
  const records = new Map((await db.selectFrom('records').select(['id', 'title', 'call_number']).where('id', 'in', ids((r) => r.record_id)).execute()).map((r) => [r.id, r]));
  const itemIds = ids((r) => r.item_id);
  const items = new Map(
    itemIds.length === 0 ? [] : (await db.selectFrom('items').select(['id', 'barcode_display', 'call_number']).where('id', 'in', itemIds).execute()).map((r) => [r.id, r]),
  );
  const memberIds = ids((r) => r.member_id);
  const members = new Map(
    memberIds.length === 0
      ? []
      : (await db.selectFrom('members').select(['id', 'member_no_display', 'name', 'class_name']).where('id', 'in', memberIds).execute()).map((r) => [r.id, r]),
  );
  const branches = new Map(
    (await db.selectFrom('branches').select(['id', 'code_display', 'name']).where('id', 'in', ids((r) => r.pickup_branch_id)).execute()).map((r) => [r.id, r]),
  );
  // The queues of the waiting holds' titles: positions counted in JS from one read per record.
  const waiting = rows.filter((r) => r.status === 'waiting');
  const positions = new Map<string, number>();
  if (waiting.length > 0) {
    const queue = await db
      .selectFrom('holds')
      .select(['id', 'record_id', 'pickup_branch_id'])
      .where('record_id', 'in', [...new Set(waiting.map((r) => r.record_id))])
      .where('status', '=', 'waiting')
      .orderBy('placed_at')
      .orderBy('id')
      .execute();
    const seen = new Map<string, number>();
    for (const q of queue) {
      const k = `${q.record_id}/${q.pickup_branch_id}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      positions.set(q.id, n);
    }
  }
  return rows.map((r) => {
    const rec = records.get(r.record_id);
    const item = r.item_id === null ? undefined : items.get(r.item_id);
    const m = r.member_id === null ? undefined : members.get(r.member_id);
    const b = branches.get(r.pickup_branch_id);
    return {
      id: r.id,
      version: ok(r.version),
      status: r.status as HoldStatus,
      record: { id: r.record_id, title: rec?.title ?? '' },
      item: item === undefined ? null : { id: item.id, barcode: item.barcode_display, callNumber: item.call_number ?? rec?.call_number ?? null },
      pinned: Number(r.pinned) === 1,
      member: m === undefined ? null : { id: m.id, memberNo: m.member_no_display, name: m.name, className: m.class_name },
      pickupBranch: { id: r.pickup_branch_id, code: b?.code_display ?? '?', name: b?.name ?? '' },
      source: r.source as HoldSource,
      placedOn: r.placed_on,
      placedAt: ok(r.placed_at),
      position: r.status === 'waiting' ? (positions.get(r.id) ?? null) : null,
      readyAt: r.ready_at === null ? null : ok(r.ready_at),
      pickupUntil: r.pickup_until,
      expiresOn: r.expires_on,
      closedAt: r.closed_at === null ? null : ok(r.closed_at),
      closeReason: r.close_reason as HoldCloseReason | null,
      shelfClearedAt: r.shelf_cleared_at === null ? null : ok(r.shelf_cleared_at),
    };
  });
}

/**
 * The holds of the member `memberId`: the active ones (ready first, then waiting by the time they were placed) and,
 * with `closed`, at most `closedLimit` closed ones after them, newest first. For the desk panel and the member's own
 * page.
 */
export async function memberHolds(db: Db, memberId: string, o: { closed?: boolean; closedLimit?: number } = {}): Promise<HoldView[]> {
  const active = await db.selectFrom('holds').selectAll().where('member_id', '=', memberId).where('status', 'in', ['waiting', 'ready']).orderBy('placed_at').orderBy('id').execute();
  active.sort((a, b) => (a.status === b.status ? 0 : a.status === 'ready' ? -1 : 1));
  const closed =
    o.closed === true
      ? await db
          .selectFrom('holds')
          .selectAll()
          .where('member_id', '=', memberId)
          .where('status', 'in', ['fulfilled', 'cancelled', 'expired'])
          .orderBy('closed_at', 'desc')
          .orderBy('id', 'desc')
          .limit(o.closedLimit ?? 20)
          .execute()
      : [];
  return holdViews(db, [...active, ...closed]);
}

/**
 * One hold of the member `memberId` (their own only: another member's, or none, is NOT_FOUND), for the member area.
 *
 * @throws DomainError NOT_FOUND
 */
export async function memberHold(db: Db, memberId: string, holdId: string): Promise<HoldView> {
  const row = await db.selectFrom('holds').selectAll().where('id', '=', holdId).where('member_id', '=', memberId).executeTakeFirst();
  if (row === undefined) throw holdNotFound();
  return (await holdViews(db, [row]))[0]!;
}

/** The hold shelf of the branch `branchId` (see `HoldShelfResponse`). */
export async function holdShelf(db: Db, input: { branchId: string }, now: number): Promise<HoldShelfResponse> {
  const today = await branchToday(db, input.branchId, now);
  const ready = await db
    .selectFrom('holds')
    .selectAll()
    .where('pickup_branch_id', '=', input.branchId)
    .where('status', '=', 'ready')
    .orderBy('pickup_until')
    .orderBy('placed_at')
    .orderBy('id')
    .limit(1000)
    .execute();
  const toClear = await db
    .selectFrom('holds')
    .selectAll()
    .where('pickup_branch_id', '=', input.branchId)
    .where('status', 'in', ['expired', 'cancelled'])
    .where('ready_at', 'is not', null)
    .where('shelf_cleared_at', 'is', null)
    .orderBy('closed_at')
    .orderBy('id')
    .limit(1000)
    .execute();
  const waitingRows = await db
    .selectFrom('holds')
    .select(['id', 'record_id', 'placed_on'])
    .where('pickup_branch_id', '=', input.branchId)
    .where('status', '=', 'waiting')
    .orderBy('placed_at')
    .orderBy('id')
    .limit(5000)
    .execute();
  const byRecord = new Map<string, { waiting: number; firstPlacedOn: string; firstHoldId: string }>();
  for (const w of waitingRows) {
    const e = byRecord.get(w.record_id);
    if (e === undefined) byRecord.set(w.record_id, { waiting: 1, firstPlacedOn: w.placed_on, firstHoldId: w.id });
    else e.waiting += 1;
  }
  const titles =
    byRecord.size === 0
      ? new Map<string, string>()
      : new Map((await db.selectFrom('records').select(['id', 'title']).where('id', 'in', [...byRecord.keys()]).execute()).map((r) => [r.id, r.title]));
  const waitingTitles = [...byRecord.entries()]
    .map(([id, e]) => ({ record: { id, title: titles.get(id) ?? '' }, waiting: e.waiting, firstPlacedOn: e.firstPlacedOn, firstHoldId: e.firstHoldId }))
    .sort((a, b) => b.waiting - a.waiting || a.firstPlacedOn.localeCompare(b.firstPlacedOn) || a.record.title.localeCompare(b.record.title));
  return { today, ready: await holdViews(db, ready), toClear: await holdViews(db, toClear), waitingTitles };
}

function badCursor(): never {
  throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/**
 * A page of holds by `q` (`GET circulation/holds`): `active` (default) = waiting and ready; newest first, cursor
 * `<placedAt>.<id>`.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listHolds(db: Db, q: HoldListQuery): Promise<HoldListResponse> {
  let query = db.selectFrom('holds').selectAll();
  query = q.status === 'active' ? query.where('status', 'in', ['waiting', 'ready']) : query.where('status', '=', q.status);
  if (q.memberId !== undefined) query = query.where('member_id', '=', q.memberId);
  if (q.recordId !== undefined) query = query.where('record_id', '=', q.recordId);
  if (q.branchId !== undefined) query = query.where('pickup_branch_id', '=', q.branchId);
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.([0-9A-Z]{26})$/.exec(q.cursor);
    if (m === null || !isUlid(m[2]!)) badCursor();
    const at = Number(m[1]);
    const after = m[2]!;
    query = query.where((eb) => eb.or([eb('placed_at', '<', at), eb.and([eb('placed_at', '=', at), eb('id', '<', after)])]));
  }
  const rows = await query.orderBy('placed_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: await holdViews(db, page), nextCursor: rows.length > q.limit && last !== undefined ? `${ok(last.placed_at)}.${last.id}` : null };
}

/** The number of `ready` holds of a member (the desk panel's count). */
export function readyHoldCount(views: readonly HoldView[]): number {
  return views.filter((h) => h.status === 'ready').length;
}
