import type { DB } from '@altis/db';
import { DomainError, canTransition, ddcClassOf, newId, type ItemStatus, type VoidRefusal } from '@altis/shared';
import type {
  CirculationWarningView,
  InLibraryUseResponse,
  LoanDueResponse,
  LoanLostResponse,
  LoanVoidResponse,
} from '@altis/shared/api/circulation';
import type { Selectable, Transaction } from 'kysely';
import { writeItemEvents } from '../catalog/items/events.js';
import { formatPrice, parsePrice } from '../catalog/items/service.js';
import type { TxCtx } from '../context.js';
import { memberValidationFailed } from '../members/common.js';
import { indexRecords } from '../search/index-records.js';
import { readSettings } from '../settings/service.js';
import { closedBy, loadClosedDayRules } from './calendars.js';
import { branchToday } from './dates.js';
import { itemNotFound, itemRefs, loanNotOpen, lockItem, lockLoan, lockMemberRow, lockRecord, scannedBarcode } from './desk.js';
import { chargeSeam, chargesInstalled, holdSeam } from './seams.js';

// The desk's other actions on a loan, and reading in place:
//
// - void: undo the last loan (a wrong scan) within `circulation.loanVoidMinutes` of it, when it was not renewed and has
//   no charge, by the staff member who lent it (another's needs the override, which the route decides). The loan is
//   closed `voided` and left out of every statistic; a hold it fulfilled is ready again (holds module).
// - lost: the borrower declares the item lost. The loan is closed `lost` first (a conditional write), then the overdue
//   fine up to today, the replacement charge and the processing fee are booked (charges module); the item becomes `lost`
//   when its status allows it (`available → lost`), with a history row (`via: loan`).
// - due date: set by hand (override), never before the day it was lent; a closed day only warns.
// - read in place: one anonymous `item_uses` row per scan at the desk's branch, with the statistics dimensions; an item
//   on loan or recorded missing or lost is still counted and warns. Not audited (high volume, nobody's data).
//
// Void, lost and the due date name a loan by id: they lock the loan first (a locking read), then its item, record and
// member, and write with `open_item_id IS NOT NULL`, like a renewal. They act only on a loan of the desk's branch (any
// other branch's: 404, as if it did not exist).

type LoanRow = Selectable<DB['loans']>;

const ok = (n: number | string | bigint): number => Number(n);

function loanNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Pinjaman tidak ditemukan / Loan not found' });
}

function voidRefused(reason: VoidRefusal): DomainError {
  const text: Record<VoidRefusal, string> = {
    too_late: 'Waktu untuk membatalkan pinjaman ini sudah lewat / The time to void this loan has passed',
    other_staff: 'Pinjaman ini dibuat petugas lain / Another staff member made this loan',
    renewed: 'Pinjaman ini sudah diperpanjang / This loan was renewed',
    charged: 'Pinjaman ini sudah punya biaya / This loan has a charge',
  };
  return new DomainError('CIRC_VOID_REFUSED', { detail: text[reason], meta: { reason } });
}

/**
 * Locks the loan `loanId` and then its item, record and member (the order of every route naming a loan by id) and
 * reads it: it must be a loan of `branchId` (else 404) and open (else CIRC_LOAN_NOT_OPEN).
 */
async function lockOpenLoanOfBranch(trx: Transaction<DB>, loanId: string, branchId: string): Promise<LoanRow> {
  const lock = await lockLoan(trx, { id: loanId });
  if (lock === null) throw loanNotFound();
  if (lock.item_id !== null) await lockItem(trx, lock.item_id);
  if (lock.record_id !== null) await lockRecord(trx, lock.record_id);
  if (lock.member_id !== null) await lockMemberRow(trx, lock.member_id);
  const loan = await trx.selectFrom('loans').selectAll().where('id', '=', loanId).executeTakeFirstOrThrow();
  if (loan.branch_id !== branchId) throw loanNotFound();
  if (loan.open_item_id === null) throw loanNotOpen();
  return loan;
}

/** Closes the open loan `loan` with `outcome` (a conditional write: another desk closing it first is CIRC_LOAN_NOT_OPEN). */
async function closeLoan(tx: TxCtx, loan: LoanRow, i: { outcome: 'voided' | 'lost'; today: string; branchId: string }): Promise<void> {
  const closed = await tx.trx
    .updateTable('loans')
    .set((eb) => ({
      returned_on: i.today,
      returned_at: tx.now,
      returned_by: tx.actor.id,
      return_branch_id: i.branchId,
      outcome: i.outcome,
      open_item_id: null,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', loan.id)
    .where('open_item_id', 'is not', null)
    .executeTakeFirst();
  if (Number(closed.numUpdatedRows) !== 1) throw loanNotOpen();
}

/**
 * Voids the last loan `loanId` at the desk of `branchId` (see the top of this file) and audits `circulation.loan.void`.
 * `mayOverride`: the caller holds `circulation.desk.override` at the branch (a loan another staff member made).
 *
 * @throws DomainError NOT_FOUND; CIRC_LOAN_NOT_OPEN; CIRC_VOID_REFUSED `{reason}` (`renewed`, `too_late`,
 *   `other_staff`, `charged`)
 */
export async function voidLoan(tx: TxCtx, input: { branchId: string; loanId: string; mayOverride: boolean }): Promise<LoanVoidResponse> {
  const { trx } = tx;
  const loan = await lockOpenLoanOfBranch(trx, input.loanId, input.branchId);
  if (ok(loan.renewals) > 0) throw voidRefused('renewed');
  const minutes = (await readSettings(trx, ['circulation.loanVoidMinutes'], []))['circulation.loanVoidMinutes'] as number;
  if (tx.now - ok(loan.loaned_at) > minutes * 60_000) throw voidRefused('too_late');
  if (loan.loaned_by !== tx.actor.id && !input.mayOverride) throw voidRefused('other_staff');
  if (await chargeSeam().loanHasCharges(trx, loan.id)) throw voidRefused('charged');
  const today = await branchToday(trx, loan.branch_id, tx.now);
  await closeLoan(tx, loan, { outcome: 'voided', today, branchId: input.branchId });
  const holdId = await holdSeam().restoreFulfilledHold(tx, { loanId: loan.id });
  if (loan.record_id !== null) await indexRecords(trx, [loan.record_id], tx.now);
  await tx.audit({
    action: 'circulation.loan.void',
    entity: 'loans',
    entityId: loan.id,
    branchId: input.branchId,
    meta: { otherStaff: loan.loaned_by !== tx.actor.id, holdRestored: holdId !== null },
  });
  return { id: loan.id, version: ok(loan.version) + 1 };
}

/**
 * Closes the open loan `loanId` as lost at the desk of `branchId` (see the top of this file) and audits
 * `circulation.loan.lost`.
 *
 * @throws DomainError NOT_FOUND; CIRC_LOAN_NOT_OPEN; VALIDATION_FAILED `{path: 'replacement', code: 'required'}`
 */
export async function markLoanLost(tx: TxCtx, input: { branchId: string; loanId: string; replacement?: string; note?: string }): Promise<LoanLostResponse> {
  const { trx } = tx;
  const loan = await lockOpenLoanOfBranch(trx, input.loanId, input.branchId);
  const item = loan.item_id === null ? undefined : await trx.selectFrom('items').select(['id', 'status', 'price', 'currency']).where('id', '=', loan.item_id).executeTakeFirst();
  const s = await readSettings(trx, ['circulation.lost.useItemPrice', 'circulation.lost.processingFeeMinor'], []);
  let replacementMinor: number | null = input.replacement === undefined ? null : parsePrice(input.replacement);
  if (replacementMinor === null && s['circulation.lost.useItemPrice'] === true && item?.price !== null && item?.price !== undefined) replacementMinor = ok(item.price);
  if (replacementMinor === null) throw memberValidationFailed([{ path: 'replacement', code: 'required' }]);
  const today = await branchToday(trx, loan.branch_id, tx.now);

  await closeLoan(tx, loan, { outcome: 'lost', today, branchId: input.branchId });
  let itemStatus = item?.status ?? 'lost';
  if (item !== undefined && canTransition(item.status as ItemStatus, 'lost')) {
    await trx
      .updateTable('items')
      .set((eb) => ({ status: 'lost', updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', item.id)
      .execute();
    await writeItemEvents(tx, [{ itemId: item.id, type: 'status', fromStatus: item.status as ItemStatus, toStatus: 'lost', fields: ['status'], via: 'loan' }]);
    itemStatus = 'lost';
  }
  const seam = chargeSeam();
  await seam.bookOverdue(tx, { loanId: loan.id, dueOn: loan.due_on, until: today });
  if (loan.member_id !== null && loan.item_id !== null) {
    await seam.bookLost(tx, {
      loanId: loan.id,
      memberId: loan.member_id,
      branchId: loan.branch_id,
      itemId: loan.item_id,
      replacementMinor,
      processingFeeMinor: s['circulation.lost.processingFeeMinor'] as number,
      currency: loan.currency,
    });
  }
  if (loan.record_id !== null) await indexRecords(trx, [loan.record_id], tx.now);
  const charged = chargesInstalled();
  await tx.audit({ action: 'circulation.loan.lost', entity: 'loans', entityId: loan.id, branchId: input.branchId, meta: { charged, itemStatus } });
  return { id: loan.id, version: ok(loan.version) + 1, itemStatus, replacement: formatPrice(replacementMinor), currency: loan.currency, charged };
}

/**
 * Sets the due date of the open loan `loanId` by hand at the desk of `branchId` and audits
 * `circulation.loan.due_change`. The note is kept with the loan (after any earlier note).
 *
 * @throws DomainError NOT_FOUND; CIRC_LOAN_NOT_OPEN; VALIDATION_FAILED `{path: 'dueOn', code: 'before_loan'}`
 */
export async function changeLoanDue(tx: TxCtx, input: { branchId: string; loanId: string; dueOn: string; note: string }): Promise<LoanDueResponse> {
  const { trx } = tx;
  const loan = await lockOpenLoanOfBranch(trx, input.loanId, input.branchId);
  if (input.dueOn < loan.loaned_on) throw memberValidationFailed([{ path: 'dueOn', code: 'before_loan' }]);
  const closed = closedBy(await loadClosedDayRules(trx, loan.branch_id));
  const warnings: CirculationWarningView[] = closed(input.dueOn) ? [{ code: 'due_on_closed_day' }] : [];
  const note = loan.override_note === null ? input.note : `${loan.override_note} · ${input.note}`.slice(0, 191);
  const updated = await trx
    .updateTable('loans')
    .set((eb) => ({ due_on: input.dueOn, override_note: note, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', loan.id)
    .where('open_item_id', 'is not', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw loanNotOpen();
  await tx.audit({
    action: 'circulation.loan.due_change',
    entity: 'loans',
    entityId: loan.id,
    branchId: input.branchId,
    meta: { later: input.dueOn > loan.due_on, closedDay: warnings.length > 0 },
  });
  return { id: loan.id, version: ok(loan.version) + 1, dueOn: input.dueOn, ...(warnings.length === 0 ? {} : { warnings }) };
}

/** The statuses that say an item is not on the shelf: one read in place warns. */
const OFF_SHELF: ReadonlySet<string> = new Set(['missing', 'lost']);

/**
 * Counts one use of the item `barcode` read in place at the desk of `branchId` (see the top of this file).
 *
 * @throws DomainError NOT_FOUND (no live item); VALIDATION_FAILED `isbn_not_barcode`
 */
export async function recordInLibraryUse(tx: TxCtx, input: { branchId: string; barcode: string }): Promise<InLibraryUseResponse> {
  const { trx } = tx;
  const key = scannedBarcode(input.barcode);
  const found = key === null ? undefined : await trx.selectFrom('items').select('id').where('barcode_key', '=', key).where('archived_at', 'is', null).executeTakeFirst();
  if (found === undefined) throw itemNotFound(null);
  const { item, record, row, recordRow } = await itemRefs(trx, found.id);
  const warnings: CirculationWarningView[] = [];
  const open = await trx.selectFrom('loans').select('id').where('open_item_id', '=', row.id).executeTakeFirst();
  if (open !== undefined) warnings.push({ code: 'item_on_loan' });
  if (OFF_SHELF.has(row.status)) warnings.push({ code: 'item_status' });
  const ddc = ddcClassOf(recordRow.classification, row.call_number ?? recordRow.call_number);
  const id = newId(tx.now);
  await trx
    .insertInto('item_uses')
    .values({
      id,
      item_id: row.id,
      record_id: recordRow.id,
      branch_id: input.branchId,
      used_on: await branchToday(trx, input.branchId, tx.now),
      used_at: tx.now,
      member_id: null,
      stat_ddc: ddc.main === 'NON' ? null : (ddc.division ?? ddc.main),
      stat_material_type_id: recordRow.material_type_id,
      stat_collection_type_id: row.collection_type_id,
      source: 'desk',
      created_by: tx.actor.id,
    })
    .execute();
  return { id, item, record, status: row.status, ...(warnings.length === 0 ? {} : { warnings }) };
}
