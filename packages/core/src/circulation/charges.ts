import type { DB } from '@altis/db';
import { DomainError, newId, t, type ChargeKind, type ChargeStateRefusal, type Locale, type ManualChargeKind } from '@altis/shared';
import type { ChargeView } from '@altis/shared/api/charges';
import type { Selectable, Transaction } from 'kysely';
import { parsePrice } from '../catalog/items/service.js';
import type { TxCtx } from '../context.js';
import { lockLiveMember, memberNotFound, memberValidationFailed, type Db } from '../members/common.js';
import { registerHistoryAnonymizeStep, registerMemberBalanceProvider, registerMemberDataSection, registerMemberErasureStep } from '../members/ext/hooks.js';
import { readSettings } from '../settings/service.js';
import { chargeLeft, chargeViews, libraryCurrency, memberBalances } from './charge-views.js';
import { branchToday } from './dates.js';
import { itemNotFound, locking, lockMemberRow, scannedBarcode } from './desk.js';
import { FinePreviewer, overdueFineMinor } from './fines.js';
import { registerCirculationChargeSeam, type CirculationChargeSeam } from './seams.js';

// Charges: what a member owes, and the writers of it.
//
// - Booked by the system (the charges seam the circulation core calls, after the loan's own conditional write and under
//   its locks: item, record, member): the overdue fine of a late return, a late renewal or a loan declared lost
//   (fines.ts: the loan's copied terms, its branch's calendar), and a lost item's replacement and processing fee (each
//   a `lost` charge of its own). A lost item that comes back cancels what is left of the `lost` charges of its loan:
//   what was paid stays (a refund happens outside ALTIS), the rest is waived by an adjustment `cancel`, and a charge
//   nothing was paid of becomes `cancelled`. System charges are not audited on their own: the loan action that booked
//   them is.
// - Booked by hand at the desk (damage, a member card, anything else), with a description, optionally linked to an item.
// - Waived (part or all of what is left) with a reason, by `circulation.charges.waive`.
//
// Every writer of an existing charge locks the member first (a waive names the charge: a locking read of it comes first,
// like the routes that name a loan by id), then the charges it touches in id order, reads them, and writes `paid_minor`,
// `waived_minor` and `status` computed here, conditional on the version it read (0 rows: TX_CONFLICT). The invariant
// `paid + waived <= amount` holds on every charge. A charge is `open` while something is left, `settled` when nothing
// is, `cancelled` when it was cancelled before anything was paid.

type ChargeRow = Selectable<DB['charges']>;

const ok = (n: number | string | bigint | null | undefined): number => Number(n ?? 0);

/** The library's language (`library.locale`): the language of the lines the system writes. */
export async function libraryLocale(db: Db): Promise<Locale> {
  return (await readSettings(db, ['library.locale'], []))['library.locale'] === 'en' ? 'en' : 'id';
}

/** `text` cut to the 191 characters of a description. */
function line(text: string): string {
  return text.length <= 191 ? text : `${text.slice(0, 190)}…`;
}

function chargeNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Biaya tidak ditemukan / Charge not found' });
}

/** CIRC_CHARGE_STATE: the charge (or payment) is no longer in a state that allows the change. */
export function chargeState(status: ChargeStateRefusal): DomainError {
  const text: Record<ChargeStateRefusal, string> = {
    settled: 'Biaya ini sudah lunas / This charge is paid',
    cancelled: 'Biaya ini sudah dibatalkan / This charge was cancelled',
    voided: 'Pembayaran ini sudah dibatalkan / This payment was voided',
  };
  return new DomainError('CIRC_CHARGE_STATE', { detail: text[status], meta: { status, reason: status } });
}

export function txConflict(): DomainError {
  return new DomainError('TX_CONFLICT', { detail: 'Biaya baru saja diubah; coba lagi / The charge was just changed; try again' });
}

/** The status of a charge with these sums: `open` while something is left, else `settled` (or `cancelled`). */
export function chargeStatusOf(amount: number, paid: number, waived: number, cancelled = false): 'open' | 'settled' | 'cancelled' {
  if (amount - paid - waived > 0) return 'open';
  return cancelled && paid === 0 ? 'cancelled' : 'settled';
}

/**
 * Locks the charges `ids` and reads them, in id order: a locking read, which reads the latest committed rows whatever
 * snapshot the transaction holds (SQLite has one writer and no FOR UPDATE).
 */
export async function lockCharges(trx: Transaction<DB>, ids: readonly string[]): Promise<ChargeRow[]> {
  if (ids.length === 0) return [];
  const sorted = [...new Set(ids)].sort();
  const q = trx.selectFrom('charges').selectAll().where('id', 'in', sorted).orderBy('id');
  return (locking(trx) ? q.forUpdate() : q).execute();
}

/** Writes new sums of a charge read at `row.version` (0 rows: another writer came first, TX_CONFLICT). */
export async function writeChargeSums(tx: TxCtx, row: ChargeRow, sums: { paid: number; waived: number; status: string }): Promise<void> {
  const amount = ok(row.amount_minor);
  if (sums.paid < 0 || sums.waived < 0 || sums.paid + sums.waived > amount) {
    throw new TypeError(`charge ${row.id}: paid ${sums.paid} + waived ${sums.waived} must stay within 0 and ${amount}`);
  }
  const done = await tx.trx
    .updateTable('charges')
    .set({ paid_minor: sums.paid, waived_minor: sums.waived, status: sums.status, version: ok(row.version) + 1, updated_at: tx.now, updated_by: tx.actor.id })
    .where('id', '=', row.id)
    .where('version', '=', ok(row.version))
    .executeTakeFirst();
  if (Number(done.numUpdatedRows) !== 1) throw txConflict();
}

/** Inserts a charge; its id. */
async function insertCharge(
  tx: TxCtx,
  c: { memberId: string; branchId: string; loanId: string | null; itemId: string | null; kind: ChargeKind; description: string; amountMinor: number; currency: string; chargedOn: string; source: 'desk' | 'system' },
): Promise<string> {
  const id = newId(tx.now);
  await tx.trx
    .insertInto('charges')
    .values({
      id,
      member_id: c.memberId,
      branch_id: c.branchId,
      loan_id: c.loanId,
      item_id: c.itemId,
      kind: c.kind,
      description: line(c.description),
      amount_minor: c.amountMinor,
      paid_minor: 0,
      waived_minor: 0,
      currency: c.currency,
      status: 'open',
      charged_on: c.chargedOn,
      charged_at: tx.now,
      date_unknown: 0,
      source: c.source,
      version: 0,
      created_at: tx.now,
      created_by: tx.actor.id,
      updated_at: tx.now,
      updated_by: tx.actor.id,
    })
    .execute();
  return id;
}

/** The barcode and title of an item, for the lines the system writes. */
async function itemLine(db: Db, itemId: string | null): Promise<{ barcode: string; title: string }> {
  if (itemId === null) return { barcode: '', title: '' };
  const row = await db
    .selectFrom('items as i')
    .leftJoin('records as r', 'r.id', 'i.record_id')
    .select(['i.barcode_display', 'r.title'])
    .where('i.id', '=', itemId)
    .executeTakeFirst();
  return { barcode: row?.barcode_display ?? '', title: row?.title ?? '' };
}

// ---- booked by the system --------------------------------------------------------------------------------------------

/**
 * Books the overdue fine of the loan `loanId` for the days after `dueOn` up to `until` (fines.ts); nothing when the fine
 * is 0 or the loan has no member. Its id, or null.
 */
export async function bookOverdueFine(tx: TxCtx, i: { loanId: string; dueOn: string; until: string }): Promise<string | null> {
  const loan = await tx.trx.selectFrom('loans').selectAll().where('id', '=', i.loanId).executeTakeFirst();
  if (loan === undefined || loan.member_id === null) return null;
  const terms = { finePerDayMinor: ok(loan.fine_per_day_minor), fineCapMinor: loan.fine_cap_minor === null ? null : ok(loan.fine_cap_minor), graceDays: ok(loan.grace_days) };
  if (terms.finePerDayMinor <= 0) return null;
  const days = await (await FinePreviewer.open(tx.trx)).lateDays(loan.branch_id, i.dueOn, i.until);
  const amount = overdueFineMinor(days, terms);
  if (amount <= 0) return null;
  const locale = await libraryLocale(tx.trx);
  const item = await itemLine(tx.trx, loan.item_id);
  return insertCharge(tx, {
    memberId: loan.member_id,
    branchId: loan.branch_id,
    loanId: loan.id,
    itemId: loan.item_id,
    kind: 'overdue',
    description: t(locale, 'charge.text.overdue', { days, barcode: item.barcode, title: item.title }),
    amountMinor: amount,
    currency: loan.currency,
    chargedOn: i.until,
    source: 'system',
  });
}

/** Books a lost item's replacement and, when > 0, its processing fee (each a `lost` charge); their ids. */
export async function bookLostCharges(
  tx: TxCtx,
  i: { loanId: string; memberId: string; branchId: string; itemId: string; replacementMinor: number; processingFeeMinor: number; currency: string },
): Promise<string[]> {
  const today = await branchToday(tx.trx, i.branchId, tx.now);
  const locale = await libraryLocale(tx.trx);
  const item = await itemLine(tx.trx, i.itemId);
  const ids: string[] = [];
  const base = { memberId: i.memberId, branchId: i.branchId, loanId: i.loanId, itemId: i.itemId, kind: 'lost' as const, currency: i.currency, chargedOn: today, source: 'system' as const };
  if (i.replacementMinor > 0) {
    ids.push(await insertCharge(tx, { ...base, description: t(locale, 'charge.text.lost', { barcode: item.barcode, title: item.title }), amountMinor: i.replacementMinor }));
  }
  if (i.processingFeeMinor > 0) {
    ids.push(await insertCharge(tx, { ...base, description: t(locale, 'charge.text.lost_fee', { barcode: item.barcode }), amountMinor: i.processingFeeMinor }));
  }
  return ids;
}

/**
 * Cancels what is left of the open `lost` charges of the loan `loanId` (its item came back): an adjustment `cancel`
 * each, what was paid stays. The caller holds the member's lock. The number of charges changed.
 */
export async function cancelLostCharges(tx: TxCtx, i: { loanId: string }): Promise<number> {
  const open = await tx.trx.selectFrom('charges').select('id').where('loan_id', '=', i.loanId).where('kind', '=', 'lost').where('status', '=', 'open').execute();
  if (open.length === 0) return 0;
  const locale = await libraryLocale(tx.trx);
  let changed = 0;
  for (const row of await lockCharges(
    tx.trx,
    open.map((r) => r.id),
  )) {
    if (row.status !== 'open') continue;
    const left = chargeLeft(row);
    if (left <= 0) continue;
    const paid = ok(row.paid_minor);
    const waived = ok(row.waived_minor) + left;
    await writeChargeSums(tx, row, { paid, waived, status: chargeStatusOf(ok(row.amount_minor), paid, waived, true) });
    await tx.trx
      .insertInto('charge_adjustments')
      .values({ id: newId(tx.now), charge_id: row.id, kind: 'cancel', amount_minor: left, reason_text: t(locale, 'charge.text.item_returned'), at: tx.now, by: tx.actor.id })
      .execute();
    changed += 1;
  }
  return changed;
}

/** Whether the loan `loanId` has any charge. */
export async function loanHasCharges(db: Db, loanId: string): Promise<boolean> {
  return (await db.selectFrom('charges').select('id').where('loan_id', '=', loanId).limit(1).executeTakeFirst()) !== undefined;
}

// ---- booked and waived at the desk -----------------------------------------------------------------------------------

/** A positive amount in minor units, or the field error `{path, code: 'too_small'}`. */
export function positiveAmount(text: string, path = 'amount'): number {
  const minor = parsePrice(text);
  if (minor === null || minor <= 0) throw memberValidationFailed([{ path, code: 'too_small' }]);
  return minor;
}

/**
 * Books a charge by hand for the live member `memberId` at the desk of `branchId` and audits `circulation.charge.create`.
 *
 * @throws DomainError NOT_FOUND (the member; the item of `barcode`); VALIDATION_FAILED `{path: 'amount', code:
 *   'too_small'}`, `isbn_not_barcode`
 */
export async function createCharge(
  tx: TxCtx,
  i: { branchId: string; memberId: string; kind: ManualChargeKind; amount: string; description: string; barcode?: string },
): Promise<ChargeView> {
  if (!(await lockLiveMember(tx.trx, i.memberId))) throw memberNotFound();
  const amountMinor = positiveAmount(i.amount);
  let itemId: string | null = null;
  if (i.barcode !== undefined) {
    const key = scannedBarcode(i.barcode);
    const item = key === null ? undefined : await tx.trx.selectFrom('items').select('id').where('barcode_key', '=', key).where('archived_at', 'is', null).executeTakeFirst();
    if (item === undefined) throw itemNotFound(null);
    itemId = item.id;
  }
  const id = await insertCharge(tx, {
    memberId: i.memberId,
    branchId: i.branchId,
    loanId: null,
    itemId,
    kind: i.kind,
    description: i.description,
    amountMinor,
    currency: await libraryCurrency(tx.trx),
    chargedOn: await branchToday(tx.trx, i.branchId, tx.now),
    source: 'desk',
  });
  await tx.audit({ action: 'circulation.charge.create', entity: 'charges', entityId: id, branchId: i.branchId, meta: { kind: i.kind, item: itemId !== null } });
  const row = await tx.trx.selectFrom('charges').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return (await chargeViews(tx.trx, [row]))[0]!;
}

/**
 * Waives `amount` (all that is left without it) of the open charge `chargeId` of the branch `branchId`, with a reason,
 * and audits `circulation.charge.waive`.
 *
 * @throws DomainError NOT_FOUND (none at this branch); CIRC_CHARGE_STATE `{status}`; VALIDATION_FAILED `{path: 'amount',
 *   code: 'too_small' | 'exceeds_balance'}`; TX_CONFLICT
 */
export async function waiveCharge(tx: TxCtx, i: { branchId: string; chargeId: string; amount?: string; reason: string }): Promise<ChargeView> {
  const { trx } = tx;
  const q = trx.selectFrom('charges').select(['id', 'member_id', 'branch_id']).where('id', '=', i.chargeId);
  const lock = await (locking(trx) ? q.forUpdate() : q).executeTakeFirst();
  if (lock === undefined || lock.branch_id !== i.branchId) throw chargeNotFound();
  await lockMemberRow(trx, lock.member_id);
  const [row] = await lockCharges(trx, [i.chargeId]);
  if (row === undefined) throw chargeNotFound();
  if (row.status !== 'open') throw chargeState(row.status === 'cancelled' ? 'cancelled' : 'settled');
  const left = chargeLeft(row);
  const minor = i.amount === undefined ? left : positiveAmount(i.amount);
  if (minor > left) throw memberValidationFailed([{ path: 'amount', code: 'exceeds_balance' }]);
  const paid = ok(row.paid_minor);
  const waived = ok(row.waived_minor) + minor;
  await writeChargeSums(tx, row, { paid, waived, status: chargeStatusOf(ok(row.amount_minor), paid, waived) });
  await trx.insertInto('charge_adjustments').values({ id: newId(tx.now), charge_id: row.id, kind: 'waive', amount_minor: minor, reason_text: i.reason, at: tx.now, by: tx.actor.id }).execute();
  await tx.audit({ action: 'circulation.charge.waive', entity: 'charges', entityId: row.id, branchId: i.branchId, meta: { kind: row.kind, whole: minor === left } });
  const after = await trx.selectFrom('charges').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
  return (await chargeViews(trx, [after]))[0]!;
}

// ---- privacy ---------------------------------------------------------------------------------------------------------

/**
 * For the anonymisation of loan history: the charges of the loans `loanIds` that are settled or cancelled lose their
 * loan, their item and their description (amount, kind, dates, branch and member stay, as a financial record), so a
 * charge can no longer tie an anonymised loan back to its borrower. Open charges keep them. The number changed.
 */
export async function anonymizeLoanCharges(trx: Transaction<DB>, loanIds: readonly string[], now: number): Promise<number> {
  let changed = 0;
  const ids = [...new Set(loanIds)];
  for (let k = 0; k < ids.length; k += 500) {
    const done = await trx
      .updateTable('charges')
      .set((eb) => ({ loan_id: null, item_id: null, description: '', updated_at: now, updated_by: null, version: eb('version', '+', 1) }))
      .where('loan_id', 'in', ids.slice(k, k + 500))
      .where('status', 'in', ['settled', 'cancelled'])
      .executeTakeFirst();
    changed += Number(done.numUpdatedRows);
  }
  return changed;
}

// ---- the seam --------------------------------------------------------------------------------------------------------

/** What the circulation core calls (seams.ts), plugged in when this module loads. */
export const CHARGES_SEAM: CirculationChargeSeam = Object.freeze({
  bookOverdue: async (tx: TxCtx, i: { loanId: string; dueOn: string; until: string }) => void (await bookOverdueFine(tx, i)),
  bookLost: async (tx: TxCtx, i: Parameters<CirculationChargeSeam['bookLost']>[1]) => void (await bookLostCharges(tx, i)),
  cancelLost: async (tx: TxCtx, i: { loanId: string }) => void (await cancelLostCharges(tx, i)),
  loanHasCharges,
  balances: memberBalances,
});

registerCirculationChargeSeam(CHARGES_SEAM);

// ---- the member's data -----------------------------------------------------------------------------------------------

// What a member owes keeps the member from being archived (one by one or in bulk) and from being anonymised.
registerMemberBalanceProvider({
  name: 'charges',
  balanceMinor: async (db, memberId) => (await memberBalances(db, [memberId])).get(memberId) ?? 0,
});

// A member's charges, with their waives and cancellations, are part of the member's own data.
registerMemberDataSection({
  name: 'charges',
  read: async (db, memberId) => {
    const rows = await db
      .selectFrom('charges as c')
      .leftJoin('items as i', 'i.id', 'c.item_id')
      .select(['c.id', 'c.kind', 'c.description', 'i.barcode_display', 'c.amount_minor', 'c.paid_minor', 'c.waived_minor', 'c.currency', 'c.status', 'c.charged_on', 'c.source'])
      .where('c.member_id', '=', memberId)
      .orderBy('c.charged_at')
      .orderBy('c.id')
      .execute();
    const adjustments = new Map<string, { kind: string; amountMinor: number; reason: string; at: number }[]>();
    const ids = rows.map((r) => r.id);
    for (let k = 0; k < ids.length; k += 500) {
      const found = await db
        .selectFrom('charge_adjustments')
        .select(['charge_id', 'kind', 'amount_minor', 'reason_text', 'at'])
        .where('charge_id', 'in', ids.slice(k, k + 500))
        .orderBy('at')
        .orderBy('id')
        .execute();
      for (const a of found) adjustments.set(a.charge_id, [...(adjustments.get(a.charge_id) ?? []), { kind: a.kind, amountMinor: ok(a.amount_minor), reason: a.reason_text, at: ok(a.at) }]);
    }
    return rows.map((r) => ({
      kind: r.kind,
      description: r.description,
      barcode: r.barcode_display ?? null,
      amountMinor: ok(r.amount_minor),
      paidMinor: ok(r.paid_minor),
      waivedMinor: ok(r.waived_minor),
      currency: r.currency,
      status: r.status,
      chargedOn: r.charged_on,
      source: r.source,
      adjustments: adjustments.get(r.id) ?? [],
    }));
  },
});

// Anonymising a member empties the free text of the member's charges and of their waives (amounts, kinds and dates
// stay, as the financial record).
registerMemberErasureStep({
  name: 'charges',
  run: async (tx, memberId) => {
    const ids = (await tx.trx.selectFrom('charges').select('id').where('member_id', '=', memberId).execute()).map((r) => r.id);
    if (ids.length === 0) return;
    await tx.trx.updateTable('charges').set({ description: '' }).where('member_id', '=', memberId).where('description', '<>', '').execute();
    for (let k = 0; k < ids.length; k += 500) {
      await tx.trx.updateTable('charge_adjustments').set({ reason_text: '' }).where('charge_id', 'in', ids.slice(k, k + 500)).where('reason_text', '<>', '').execute();
    }
  },
});

// The daily history anonymisation: once a loan lost its member, its settled or cancelled charges lose the loan, the item
// and the line (an open one keeps them until it is settled, then a later run takes them).
registerHistoryAnonymizeStep({
  name: 'charges',
  run: async (trx, cut) => {
    const rows = await trx
      .selectFrom('charges as c')
      .innerJoin('loans as l', 'l.id', 'c.loan_id')
      .select('c.loan_id')
      .where('l.member_id', 'is', null)
      .where('c.status', 'in', ['settled', 'cancelled'])
      .orderBy('c.id')
      .limit(500)
      .execute();
    return anonymizeLoanCharges(
      trx,
      rows.map((r) => r.loan_id).filter((id): id is string => id !== null),
      cut.now,
    );
  },
});
