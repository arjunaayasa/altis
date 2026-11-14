import { countRows, fullTextFamily, type DB } from '@altis/db';
import { DomainError, ddcClassOf, diffDays, isDomainError, newId, type MemberStatus, type RenewRefusal } from '@altis/shared';
import type {
  CirculationWarningView,
  DeskLoanView,
  DeskMemberSearchResponse,
  DeskMemberView,
  LoanItemRef,
  LoanRecordRef,
  LoanResponse,
  RenewAllResponse,
  RenewResponse,
  ReturnResponse,
} from '@altis/shared/api/circulation';
import type { MemberTypeRef } from '@altis/shared/api/members';
import type { Selectable, Transaction } from 'kysely';
import { barcodeProblem, normalizeBarcode } from '../catalog/lib/barcode.js';
import type { TxCtx } from '../context.js';
import { lockLiveMember, memberNotFound, memberStatusOf, memberValidationFailed, openLoanCount, type Db } from '../members/common.js';
import { findLiveMemberByNo, memberQueryWhere } from '../members/members.js';
import { indexRecords } from '../search/index-records.js';
import { branchToday, dueDateFor } from './dates.js';
import { resolvePolicy } from './policies.js';

// The circulation desk: lend, return and renew, and the member panel.
//
// Lock order. Every write takes its locks as its first statements, always in the order item, record, member, so two
// desk writes never wait on each other in a circle:
// - lend: a locking read of the item by its barcode (`SELECT … FOR UPDATE`; SQLite has one writer and no FOR UPDATE),
//   a write that changes nothing on its record, then on the member (matching only a member that is neither archived
//   nor anonymised). Then plain reads and the checks, in this order: the member (404, MEMBER_SUSPENDED,
//   MEMBER_EXPIRED), the item (404, with the hint `member_no` when the scanned text is a member number; an ISBN is the
//   field error `isbn_not_barcode`), the desk's branch (CIRC_OTHER_BRANCH), the item's status (`available`, else
//   CIRC_NOT_LOANABLE `status`), no open loan (CIRC_ITEM_ON_LOAN), the collection type (CIRC_NOT_LOANABLE
//   `collection_type`), the rule (CIRC_NO_POLICY; CIRC_NOT_LOANABLE `policy`), the limits (CIRC_LIMIT_REACHED: the
//   member type's limit on all open loans, the rule's on the open loans made under that rule). The loan is inserted
//   with `open_item_id` = the item: that unique key is the final guarantee of one open loan per item (a write that
//   still meets it is CIRC_ITEM_ON_LOAN).
// - return: the item by its barcode, its record, a locking read of its open loan, then the loan's member. The close is
//   a conditional write (`open_item_id IS NOT NULL`): a loan another desk closed first is CIRC_LOAN_NOT_OPEN.
// - renew: a locking read of the loan by id, then its item, record and member; the write is conditional on the
//   renewals read (another renewal first: CIRC_RENEW_REFUSED `changed`).
// Lend and return refresh the record's search document (its facet `av`) under the record lock they hold. "On loan" is
// never an item status: the item stays `available`, the open loan says it is out.
//
// Dates are the loan branch's (dates.ts). A member whose membership ends within 30 days gets `member_expires_soon`.

type LoanRow = Selectable<DB['loans']>;
type MemberRow = Selectable<DB['members']>;

/** A member whose membership ends within this many days is warned at the desk. */
export const EXPIRY_WARNING_DAYS = 30;

// ---- errors ----------------------------------------------------------------------------------------------------------

function itemNotFound(hint: 'member_no' | null): DomainError {
  return new DomainError('NOT_FOUND', {
    detail:
      hint === 'member_no'
        ? 'Barkod ini adalah nomor anggota, bukan eksemplar / This barcode is a member number, not an item'
        : 'Eksemplar tidak ditemukan / Item not found',
    meta: hint === null ? {} : { hint, reason: hint },
  });
}

function notLoanable(reason: 'status' | 'collection_type' | 'policy', status?: string): DomainError {
  const text = {
    status: 'Status eksemplar tidak memungkinkan peminjaman / The item status does not allow a loan',
    collection_type: 'Tipe koleksi ini tidak boleh dipinjam / This collection type may not be lent',
    policy: 'Aturan peminjaman tidak mengizinkan pinjaman ini / The loan rule does not allow this loan',
  }[reason];
  return new DomainError('CIRC_NOT_LOANABLE', { detail: text, meta: { reason, ...(status === undefined ? {} : { status }) } });
}

function loanNotOpen(): DomainError {
  return new DomainError('CIRC_LOAN_NOT_OPEN', { detail: 'Pinjaman ini sudah tidak terbuka / This loan is no longer open' });
}

function renewRefused(reason: RenewRefusal): DomainError {
  const text: Partial<Record<RenewRefusal, string>> = {
    changed: 'Pinjaman baru saja diubah di meja lain / The loan was just changed at another desk',
    suspended: 'Keanggotaan sedang ditangguhkan / The membership is suspended',
    expired: 'Keanggotaan sudah habis / The membership has expired',
    same_day: 'Pinjaman ini dipinjam atau diperpanjang hari ini / This loan was made or renewed today',
    limit: 'Batas perpanjangan sudah tercapai / The renewal limit is reached',
  };
  return new DomainError('CIRC_RENEW_REFUSED', { detail: text[reason] ?? 'Perpanjangan ditolak / The renewal was refused', meta: { reason } });
}

function limitReached(scope: 'member_type' | 'policy', limit: number): DomainError {
  return new DomainError('CIRC_LIMIT_REACHED', {
    detail:
      limit === 0
        ? 'Anggota ini tidak boleh meminjam / This member may not borrow'
        : `Batas ${limit} pinjaman terbuka sudah tercapai / The limit of ${limit} open loans is reached`,
    meta: { scope, limit, reason: scope },
  });
}

function suspended(): DomainError {
  return new DomainError('MEMBER_SUSPENDED', { detail: 'Keanggotaan sedang ditangguhkan / The membership is suspended' });
}

function expired(expiresOn: string): DomainError {
  return new DomainError('MEMBER_EXPIRED', { detail: `Keanggotaan habis pada ${expiresOn} / The membership expired on ${expiresOn}`, meta: { expiresOn } });
}

// ---- locks -----------------------------------------------------------------------------------------------------------

/** Whether the connection supports `FOR UPDATE` (SQLite has one writer and none). */
function locking(trx: Transaction<DB>): boolean {
  return fullTextFamily(trx) !== 'fts5';
}

/** A locking read of the live item holding the normalised barcode `key`. */
async function lockItemByBarcode(trx: Transaction<DB>, key: string): Promise<{ id: string; record_id: string; branch_id: string } | null> {
  const q = trx.selectFrom('items').select(['id', 'record_id', 'branch_id']).where('barcode_key', '=', key).where('archived_at', 'is', null);
  return (await (locking(trx) ? q.forUpdate() : q).executeTakeFirst()) ?? null;
}

async function lockRecord(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

async function lockItem(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('items')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/** Locks the member `id` whatever its state (a loan's member, which is never archived while the loan is open). */
async function lockMemberRow(trx: Transaction<DB>, id: string): Promise<void> {
  await trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .execute();
}

/** A locking read of one loan by `where`. */
async function lockLoan(trx: Transaction<DB>, by: { id: string } | { openItemId: string }): Promise<{ id: string; item_id: string | null; record_id: string | null; member_id: string | null } | null> {
  let q = trx.selectFrom('loans').select(['id', 'item_id', 'record_id', 'member_id']);
  q = 'id' in by ? q.where('id', '=', by.id) : q.where('open_item_id', '=', by.openItemId);
  return (await (locking(trx) ? q.forUpdate() : q).executeTakeFirst()) ?? null;
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

/**
 * A scanned barcode normalised: its key, or VALIDATION_FAILED `isbn_not_barcode` for an ISBN, or null when the text
 * cannot be any barcode (it is then simply not found).
 */
function scannedBarcode(raw: string): string | null {
  const key = normalizeBarcode(raw);
  const problem = barcodeProblem(key);
  if (problem === 'isbn_not_barcode') throw memberValidationFailed([{ path: 'barcode', code: 'isbn_not_barcode' }]);
  return problem === null ? key : null;
}

/** The warnings of a member at `today`: `member_expires_soon` within {@link EXPIRY_WARNING_DAYS} days. */
function memberWarnings(expiresOn: string | null, today: string): CirculationWarningView[] {
  if (expiresOn === null || expiresOn < today) return [];
  return diffDays(today, expiresOn) <= EXPIRY_WARNING_DAYS ? [{ code: 'member_expires_soon', expiresOn }] : [];
}

/** The item and record refs of an item. */
async function itemRefs(db: Db, itemId: string): Promise<{ item: LoanItemRef; record: LoanRecordRef; row: Selectable<DB['items']>; recordRow: Selectable<DB['records']> }> {
  const row = await db.selectFrom('items').selectAll().where('id', '=', itemId).executeTakeFirstOrThrow();
  const recordRow = await db.selectFrom('records').selectAll().where('id', '=', row.record_id).executeTakeFirstOrThrow();
  return {
    item: { id: row.id, barcode: row.barcode_display, callNumber: row.call_number ?? recordRow.call_number },
    record: { id: recordRow.id, title: recordRow.title },
    row,
    recordRow,
  };
}

const ok = (n: number | string | bigint): number => Number(n);

// ---- lend ------------------------------------------------------------------------------------------------------------

/**
 * Lends the item `barcode` to the member `memberId` at the desk of `branchId` (see the top of this file) and audits
 * `circulation.loan.create`.
 *
 * @throws DomainError NOT_FOUND (member; item, `meta.hint` `member_no`); VALIDATION_FAILED `isbn_not_barcode`;
 *   MEMBER_SUSPENDED; MEMBER_EXPIRED; CIRC_OTHER_BRANCH; CIRC_NOT_LOANABLE; CIRC_ITEM_ON_LOAN; CIRC_NO_POLICY;
 *   CIRC_LIMIT_REACHED
 */
export async function lendItem(tx: TxCtx, input: { branchId: string; memberId: string; barcode: string }): Promise<LoanResponse> {
  const { trx } = tx;
  const key = scannedBarcode(input.barcode);
  // The locks: the item, its record, the member (the first statements).
  const locked = key === null ? null : await lockItemByBarcode(trx, key);
  if (locked !== null) await lockRecord(trx, locked.record_id);
  if (!(await lockLiveMember(trx, input.memberId))) throw memberNotFound();

  const member = await trx.selectFrom('members').selectAll().where('id', '=', input.memberId).executeTakeFirstOrThrow();
  if (member.status === 'suspended') throw suspended();
  const itemBranch = locked?.branch_id ?? input.branchId;
  const today = await branchToday(trx, itemBranch, tx.now);
  if (member.expires_on !== null && member.expires_on < today) throw expired(member.expires_on);

  if (locked === null) {
    const asMember = await findLiveMemberByNo(trx, input.barcode);
    throw itemNotFound(asMember === null ? null : 'member_no');
  }
  const { item, record, row: itemRow, recordRow } = await itemRefs(trx, locked.id);
  if (itemRow.branch_id !== input.branchId) {
    const b = await trx.selectFrom('branches').select('code_display').where('id', '=', itemRow.branch_id).executeTakeFirst();
    const branchCode = b?.code_display ?? '?';
    throw new DomainError('CIRC_OTHER_BRANCH', {
      detail: `Eksemplar ini milik cabang ${branchCode} / This item belongs to branch ${branchCode}`,
      meta: { branchCode },
    });
  }
  if (itemRow.status !== 'available') throw notLoanable('status', itemRow.status);
  const open = await trx.selectFrom('loans').select('member_id').where('open_item_id', '=', itemRow.id).executeTakeFirst();
  if (open !== undefined) {
    const sameMember = open.member_id === member.id;
    throw new DomainError('CIRC_ITEM_ON_LOAN', {
      detail: sameMember ? 'Eksemplar ini sudah dipinjam anggota ini / This member already has this item' : 'Eksemplar ini sedang dipinjam / This item is on loan',
      meta: { sameMember, reason: sameMember ? 'same_member' : 'other_member' },
    });
  }
  const ct = await trx.selectFrom('collection_types').select('loanable').where('id', '=', itemRow.collection_type_id).executeTakeFirst();
  if (ct !== undefined && Number(ct.loanable) !== 1) throw notLoanable('collection_type');

  const policy = await resolvePolicy(trx, {
    memberTypeId: member.member_type_id,
    collectionTypeId: itemRow.collection_type_id,
    materialTypeId: recordRow.material_type_id,
    branchId: itemRow.branch_id,
  });
  if (policy === null) throw new DomainError('CIRC_NO_POLICY', { detail: 'Tidak ada aturan peminjaman yang berlaku / No loan rule applies' });
  if (Number(policy.loanable) !== 1) throw notLoanable('policy');

  const type = await trx.selectFrom('member_types').select(['loan_limit', 'accred_group']).where('id', '=', member.member_type_id).executeTakeFirst();
  const openLoans = await openLoanCount(trx, member.id);
  if (type?.loan_limit !== null && type?.loan_limit !== undefined && openLoans >= ok(type.loan_limit)) throw limitReached('member_type', ok(type.loan_limit));
  if (policy.loan_limit !== null) {
    const underRule = await countRows(
      trx.selectFrom('loans').select('id').where('member_id', '=', member.id).where('policy_id', '=', policy.id).where('open_item_id', 'is not', null),
    );
    if (underRule >= ok(policy.loan_limit)) throw limitReached('policy', ok(policy.loan_limit));
  }

  const due = await dueDateFor(trx, { loanedOn: today, days: ok(policy.loan_days), expiresOn: member.expires_on, branchId: itemRow.branch_id });
  const ddc = ddcClassOf(recordRow.classification, itemRow.call_number ?? recordRow.call_number);
  const id = newId(tx.now);
  try {
    await trx
      .insertInto('loans')
      .values({
        id,
        item_id: itemRow.id,
        open_item_id: itemRow.id,
        record_id: recordRow.id,
        member_id: member.id,
        branch_id: itemRow.branch_id,
        policy_id: policy.id,
        loaned_on: today,
        loaned_at: tx.now,
        due_on: due.dueOn,
        renewals: 0,
        last_renewed_on: null,
        returned_on: null,
        returned_at: null,
        return_branch_id: null,
        outcome: null,
        loan_days: ok(policy.loan_days),
        renew_limit: ok(policy.renew_limit),
        grace_days: ok(policy.grace_days),
        fine_per_day_minor: ok(policy.fine_per_day_minor),
        fine_cap_minor: policy.fine_cap_minor === null ? null : ok(policy.fine_cap_minor),
        currency: policy.currency,
        overrides: null,
        override_note: null,
        loaned_by: tx.actor.id,
        returned_by: null,
        source: 'desk',
        stat_ddc: ddc.main === 'NON' ? null : (ddc.division ?? ddc.main),
        stat_material_type_id: recordRow.material_type_id,
        stat_collection_type_id: itemRow.collection_type_id,
        stat_location_id: itemRow.location_id,
        stat_member_type_id: member.member_type_id,
        stat_accred_group: type?.accred_group ?? null,
        stat_class_name: member.class_name,
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') {
      throw new DomainError('CIRC_ITEM_ON_LOAN', { detail: 'Eksemplar ini sedang dipinjam / This item is on loan', meta: { sameMember: false, reason: 'other_member' } });
    }
    throw error;
  }
  await indexRecords(trx, [recordRow.id], tx.now);
  const warnings: CirculationWarningView[] = [...memberWarnings(member.expires_on, today), ...(due.capped ? [{ code: 'due_capped_by_expiry' as const }] : [])];
  await tx.audit({
    action: 'circulation.loan.create',
    entity: 'loans',
    entityId: id,
    branchId: itemRow.branch_id,
    meta: { warnings: warnings.map((w) => w.code) },
  });
  return { id, version: 0, dueOn: due.dueOn, item, record, ...(warnings.length === 0 ? {} : { warnings }) };
}

// ---- return ----------------------------------------------------------------------------------------------------------

/**
 * Closes the open loan of the item `barcode` (`returned`) at the desk of `branchId`, any branch (another branch's item
 * warns `return_to_branch`), and audits `circulation.loan.return`.
 *
 * @throws DomainError NOT_FOUND (the item); VALIDATION_FAILED `isbn_not_barcode`; CIRC_LOAN_NOT_OPEN
 */
export async function returnItem(tx: TxCtx, input: { branchId: string; barcode: string }): Promise<ReturnResponse> {
  const { trx } = tx;
  const key = scannedBarcode(input.barcode);
  const locked = key === null ? null : await lockItemByBarcode(trx, key);
  if (locked === null) throw itemNotFound(null);
  await lockRecord(trx, locked.record_id);
  const loanLock = await lockLoan(trx, { openItemId: locked.id });
  if (loanLock === null) throw loanNotOpen();
  if (loanLock.member_id !== null) await lockMemberRow(trx, loanLock.member_id);

  const loan = await trx.selectFrom('loans').selectAll().where('id', '=', loanLock.id).executeTakeFirstOrThrow();
  const today = await branchToday(trx, loan.branch_id, tx.now);
  const closed = await trx
    .updateTable('loans')
    .set((eb) => ({
      returned_on: today,
      returned_at: tx.now,
      returned_by: tx.actor.id,
      return_branch_id: input.branchId,
      outcome: 'returned',
      open_item_id: null,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', loan.id)
    .where('open_item_id', 'is not', null)
    .executeTakeFirst();
  if (Number(closed.numUpdatedRows) !== 1) throw loanNotOpen();

  const { item, record, row: itemRow } = await itemRefs(trx, locked.id);
  const daysLate = Math.max(0, diffDays(loan.due_on, today));
  const warnings: CirculationWarningView[] = [];
  if (itemRow.branch_id !== input.branchId) {
    const b = await trx.selectFrom('branches').select('code_display').where('id', '=', itemRow.branch_id).executeTakeFirst();
    warnings.push({ code: 'return_to_branch', branchCode: b?.code_display ?? '?' });
  }
  const member = loan.member_id === null ? undefined : await trx.selectFrom('members').select('member_no_display').where('id', '=', loan.member_id).executeTakeFirst();
  await indexRecords(trx, [locked.record_id], tx.now);
  await tx.audit({ action: 'circulation.loan.return', entity: 'loans', entityId: loan.id, branchId: input.branchId, meta: { daysLate } });
  return {
    id: loan.id,
    version: ok(loan.version) + 1,
    memberId: loan.member_id,
    memberNo: member?.member_no_display ?? null,
    item,
    record,
    loanedOn: loan.loaned_on,
    dueOn: loan.due_on,
    returnedOn: today,
    daysLate,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

// ---- renew -----------------------------------------------------------------------------------------------------------

/** Renews the open loan `loanId` once (see the top of this file) and audits `circulation.loan.renew`. */
async function renewOne(tx: TxCtx, loanId: string, branchId: string): Promise<RenewResponse> {
  const { trx } = tx;
  const lock = await lockLoan(trx, { id: loanId });
  if (lock === null) throw new DomainError('NOT_FOUND', { detail: 'Pinjaman tidak ditemukan / Loan not found' });
  if (lock.item_id !== null) await lockItem(trx, lock.item_id);
  if (lock.record_id !== null) await lockRecord(trx, lock.record_id);
  if (lock.member_id !== null) await lockMemberRow(trx, lock.member_id);

  const loan: LoanRow = await trx.selectFrom('loans').selectAll().where('id', '=', loanId).executeTakeFirstOrThrow();
  if (loan.open_item_id === null) throw loanNotOpen();
  const member: MemberRow | undefined = loan.member_id === null ? undefined : await trx.selectFrom('members').selectAll().where('id', '=', loan.member_id).executeTakeFirst();
  const today = await branchToday(trx, loan.branch_id, tx.now);
  if (member !== undefined) {
    if (member.status === 'suspended') throw renewRefused('suspended');
    if (member.expires_on !== null && member.expires_on < today) throw renewRefused('expired');
  }
  if (loan.loaned_on === today || loan.last_renewed_on === today) throw renewRefused('same_day');
  const renewals = ok(loan.renewals);
  if (renewals >= ok(loan.renew_limit)) throw renewRefused('limit');

  const due = await dueDateFor(trx, { loanedOn: today, days: ok(loan.loan_days), expiresOn: member?.expires_on ?? null, branchId: loan.branch_id });
  const updated = await trx
    .updateTable('loans')
    .set((eb) => ({
      due_on: due.dueOn,
      renewals: renewals + 1,
      last_renewed_on: today,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', loanId)
    .where('open_item_id', 'is not', null)
    .where('renewals', '=', renewals)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw renewRefused('changed');
  const warnings: CirculationWarningView[] = [...memberWarnings(member?.expires_on ?? null, today), ...(due.capped ? [{ code: 'due_capped_by_expiry' as const }] : [])];
  await tx.audit({ action: 'circulation.loan.renew', entity: 'loans', entityId: loanId, branchId, meta: { renewals: renewals + 1 } });
  return { id: loanId, version: ok(loan.version) + 1, dueOn: due.dueOn, renewals: renewals + 1, renewLimit: ok(loan.renew_limit), ...(warnings.length === 0 ? {} : { warnings }) };
}

/**
 * Renews the open loan `loanId` at the desk of `branchId` (any branch) and audits `circulation.loan.renew`. An overdue
 * loan may be renewed: the new due date counts from today.
 *
 * @throws DomainError NOT_FOUND; CIRC_LOAN_NOT_OPEN; CIRC_RENEW_REFUSED `{reason}` (`suspended`, `expired`, `same_day`,
 *   `limit`, `changed`)
 */
export function renewLoan(tx: TxCtx, input: { branchId: string; loanId: string }): Promise<RenewResponse> {
  return renewOne(tx, input.loanId, input.branchId);
}

/**
 * Renews every open loan of the member `memberId`, each as renewLoan would (one audit entry per renewed loan); the
 * others are listed with their reason. The member's open loans are read with a locking read first, in id order (each
 * renewal then takes its own locks in the usual order).
 *
 * @throws DomainError NOT_FOUND (no live member)
 */
export async function renewAllLoans(tx: TxCtx, input: { branchId: string; memberId: string }): Promise<RenewAllResponse> {
  const { trx } = tx;
  const q = trx.selectFrom('loans').select('id').where('member_id', '=', input.memberId).where('open_item_id', 'is not', null).orderBy('id');
  const loans = await (locking(trx) ? q.forUpdate() : q).execute();
  const out: RenewAllResponse = { renewed: [], refused: [] };
  if (loans.length === 0) {
    // Nothing to renew (and nothing written): only whether the member is there is left to say.
    const member = await trx.selectFrom('members').select(['archived_at', 'anonymized_at']).where('id', '=', input.memberId).executeTakeFirst();
    if (member === undefined || member.archived_at !== null || member.anonymized_at !== null) throw memberNotFound();
    return out;
  }
  for (const { id } of loans) {
    try {
      const r = await renewOne(tx, id, input.branchId);
      out.renewed.push({ id: r.id, version: r.version, dueOn: r.dueOn, renewals: r.renewals });
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'CIRC_RENEW_REFUSED') out.refused.push({ id, reason: error.meta?.['reason'] as RenewRefusal });
      else if (error.code === 'CIRC_LOAN_NOT_OPEN') out.refused.push({ id, reason: 'not_open' });
      else throw error;
    }
  }
  return out;
}

// ---- the member panel ------------------------------------------------------------------------------------------------

/** The open loans of `memberId` as the desk lists them, the oldest due date first. */
export async function deskLoans(db: Db, memberId: string, now: number): Promise<DeskLoanView[]> {
  const rows = await db
    .selectFrom('loans as l')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .select([
      'l.id',
      'l.version',
      'l.branch_id',
      'l.loaned_on',
      'l.due_on',
      'l.renewals',
      'l.renew_limit',
      'l.item_id',
      'l.record_id',
      'i.barcode_display',
      'i.call_number as item_call_number',
      'r.call_number as record_call_number',
      'r.title',
    ])
    .where('l.member_id', '=', memberId)
    .where('l.open_item_id', 'is not', null)
    .orderBy('l.due_on')
    .orderBy('l.id')
    .execute();
  const todays = new Map<string, string>();
  const out: DeskLoanView[] = [];
  for (const r of rows) {
    let today = todays.get(r.branch_id);
    if (today === undefined) {
      today = await branchToday(db, r.branch_id, now);
      todays.set(r.branch_id, today);
    }
    out.push({
      id: r.id,
      version: ok(r.version),
      branchId: r.branch_id,
      item: { id: r.item_id ?? '', barcode: r.barcode_display ?? '', callNumber: r.item_call_number ?? r.record_call_number ?? null },
      record: { id: r.record_id ?? '', title: r.title ?? '' },
      loanedOn: r.loaned_on,
      dueOn: r.due_on,
      daysLate: Math.max(0, diffDays(r.due_on, today)),
      renewals: ok(r.renewals),
      renewLimit: ok(r.renew_limit),
    });
  }
  return out;
}

/**
 * The desk's panel of the member `memberId` at the desk of `branchId`: the fields the desk needs, the open loans and
 * whether the member may borrow now (the first reason a loan would be refused for the member alone).
 *
 * @throws DomainError NOT_FOUND (none, archived or anonymised)
 */
export async function deskMemberView(db: Db, input: { branchId: string; memberId: string }, now: number): Promise<DeskMemberView> {
  const m = await db.selectFrom('members').selectAll().where('id', '=', input.memberId).executeTakeFirst();
  if (m === undefined || m.archived_at !== null || m.anonymized_at !== null) throw memberNotFound();
  const t = await db.selectFrom('member_types').select(['id', 'code_display', 'name_id', 'name_en', 'loan_limit']).where('id', '=', m.member_type_id).executeTakeFirst();
  const type: MemberTypeRef = {
    id: m.member_type_id,
    code: t?.code_display ?? '?',
    nameId: t?.name_id ?? '?',
    nameEn: t?.name_en ?? null,
    loanLimit: t?.loan_limit === null || t?.loan_limit === undefined ? null : ok(t.loan_limit),
  };
  const today = await branchToday(db, input.branchId, now);
  const status: MemberStatus = memberStatusOf({ ...m, anonymized_at: null, archived_at: null }, today);
  const loans = await deskLoans(db, m.id, now);
  let borrowRefusal: DeskMemberView['borrowRefusal'] = null;
  if (status === 'suspended') borrowRefusal = 'MEMBER_SUSPENDED';
  else if (status === 'expired') borrowRefusal = 'MEMBER_EXPIRED';
  else if (type.loanLimit !== null && loans.length >= type.loanLimit) borrowRefusal = 'CIRC_LIMIT_REACHED';
  return {
    id: m.id,
    memberNo: m.member_no_display,
    name: m.name,
    type,
    className: m.class_name,
    status,
    statusNote: m.status_note,
    expiresOn: m.expires_on,
    photoFileId: m.photo_file_id,
    notes: m.notes,
    counts: { openLoans: loans.length, overdue: loans.filter((l) => l.daysLate > 0).length },
    canBorrow: borrowRefusal === null,
    borrowRefusal,
    loans,
    warnings: memberWarnings(m.expires_on, today),
  };
}

/**
 * The desk's panel of the live member holding the member number `raw`.
 *
 * @throws DomainError NOT_FOUND
 */
export async function deskMemberLookup(db: Db, input: { branchId: string; no: string }, now: number): Promise<DeskMemberView> {
  const m = await findLiveMemberByNo(db, input.no);
  if (m === null) throw memberNotFound();
  return deskMemberView(db, { branchId: input.branchId, memberId: m.id }, now);
}

/** At most 10 live members whose number starts with, or whose name holds every word of, `q`; by name. */
export async function deskMemberSearch(db: Db, input: { branchId: string; q: string }, now: number): Promise<DeskMemberSearchResponse> {
  const where = memberQueryWhere(input.q);
  if (where === null) return { items: [] };
  const rows = await db
    .selectFrom('members as m')
    .select(['m.id', 'm.member_no_display', 'm.name', 'm.class_name', 'm.status', 'm.expires_on', 'm.archived_at', 'm.anonymized_at'])
    .where('m.archived_at', 'is', null)
    .where('m.anonymized_at', 'is', null)
    .where(where)
    .orderBy('m.name_key')
    .orderBy('m.id')
    .limit(10)
    .execute();
  const today = await branchToday(db, input.branchId, now);
  return {
    items: rows.map((r) => ({
      id: r.id,
      memberNo: r.member_no_display,
      name: r.name,
      className: r.class_name,
      status: memberStatusOf({ status: r.status, expires_on: r.expires_on, archived_at: null, anonymized_at: null }, today),
    })),
  };
}
