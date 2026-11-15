import { assertOutsideTx, withTx, type DbHandle } from '@altis/db';
import { DomainError, isDomainError, localDate, newId, t, type Locale, type PaymentMethod } from '@altis/shared';
import type { PaymentView, ReceiptPaper } from '@altis/shared/api/charges';
import { LOCK_FOREVER } from '../catalog/items/patterns.js';
import type { TxCtx } from '../context.js';
import { lockLiveMember, memberNotFound, memberValidationFailed, type Db } from '../members/common.js';
import { registerMemberDataSection, registerMemberErasureStep } from '../members/ext/hooks.js';
import { PdfLayout } from '../print/layout.js';
import { readSettings } from '../settings/service.js';
import { chargeLeft, paymentViews } from './charge-views.js';
import { chargeState, chargeStatusOf, lockCharges, positiveAmount, writeChargeSums } from './charges.js';
import { branchTimeZone } from './dates.js';
import { locking, lockMemberRow } from './desk.js';

// Payments at the desk, their numbered receipts, and voiding them.
//
// - A payment goes to the charges chosen (each an open charge of the member at the desk's branch) or, without a
//   choice, to every open charge of the member at the desk's branch, oldest first. It may not be more than they leave
//   (`exceeds_balance`); it is spread over them in that order.
// - The receipt number is `<branch code>/<year>/<seq, 6 digits>`: `seq` is the highest of the branch and the year + 1,
//   read under the lock `circulation.receipt:<branch>:<year>` (no counter table), so there is no gap and no repeat. The
//   lock is a `locks` row made beforehand outside the transaction (ensureReceiptLockRow, LOCK_FOREVER, like the barcode
//   patterns' and the clearance letters' rows) and taken by an UPDATE as the transaction's first statement, before any
//   other lock: two desks of a branch taking payments at once wait for each other, and the snapshot of MySQL/MariaDB
//   starts after the lock. The year is the branch's (its time zone) at the request; the route works it out before the
//   transaction and the transaction works it out again after the lock, without reading anything: a new year in between
//   is TX_CONFLICT (sent again, with the new year's lock). A unique violation that still happens on (branch, year, seq)
//   is TX_CONFLICT. A voided payment keeps its number.
// - Then the member is locked, then the charges (a locking read in id order), then the sums are read and written
//   (charges first, then the payment and its allocations: the global lock order).
// - Voiding names the payment: a locking read of it comes first, then its member and its charges; what it paid is owed
//   again (each charge reopens), with the reason.
// - The receipt PDF (buildReceiptPdf) is a 58 or 80 mm roll in the library's language.

/** `locks.owner` of the receipt lock rows (never claimed). */
const LOCK_OWNER = 'circulation.receipt';

/** The name of the lock row of the receipt numbers of `branchId` in `year`. */
export function receiptLockName(branchId: string, year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new TypeError(`receipt year ${String(year)} is not a year`);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(branchId)) throw new TypeError('receipt lock: the branch id is not a ULID');
  return `circulation.receipt:${branchId}:${year}`;
}

/**
 * Makes sure the lock row of the receipt numbers of `branchId` in `year` exists with `until = LOCK_FOREVER`, in a short
 * transaction of its own outside any other (the payment route, before its transaction). A unique violation means
 * another request made it first.
 *
 * @throws TypeError inside a withTx callback
 */
export async function ensureReceiptLockRow(h: DbHandle, branchId: string, year: number): Promise<void> {
  assertOutsideTx('ensureReceiptLockRow');
  const name = receiptLockName(branchId, year);
  try {
    await withTx(h, async (trx) => {
      const row = await trx.selectFrom('locks').select('until').where('name', '=', name).executeTakeFirst();
      if (row === undefined) await trx.insertInto('locks').values({ name, owner: LOCK_OWNER, until: LOCK_FOREVER }).execute();
      else if (Number(row.until) !== LOCK_FOREVER) await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', name).execute();
    });
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') return;
    throw error;
  }
}

/** What a payment route works out before its transaction: the branch's time zone and the receipt year at `now`. */
export async function receiptYearOf(db: Db, branchId: string, now: number): Promise<{ timeZone: string; year: number }> {
  const timeZone = await branchTimeZone(db, branchId);
  return { timeZone, year: Number(localDate(timeZone, now).slice(0, 4)) };
}

/** The receipt number shown: `<branch code>/<yyyy>/<seq, 6 digits>`. */
export function receiptNumber(branchCode: string, year: number, seq: number): string {
  return `${branchCode}/${year}/${String(seq).padStart(6, '0')}`;
}

function paymentNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Pembayaran tidak ditemukan / Payment not found' });
}

function chargesNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Biaya tidak ditemukan / Charge not found' });
}

function numberTaken(): DomainError {
  return new DomainError('TX_CONFLICT', { detail: 'Nomor kuitansi baru saja dipakai; coba lagi / The receipt number was just taken; try again' });
}

/** What a payment takes. `timeZone` and `year` come from receiptYearOf, before the transaction. */
export interface PaymentInput {
  branchId: string;
  memberId: string;
  amount: string;
  method: PaymentMethod;
  chargeIds?: readonly string[];
  note?: string;
  timeZone: string;
  year: number;
}

/**
 * Takes a payment of the member `memberId` at the desk of `branchId` (see the top of this file) and audits
 * `circulation.payment.create`.
 *
 * @throws DomainError NOT_FOUND (the member; a chosen charge that is not the member's open charge at this branch);
 *   CIRC_CHARGE_STATE `{status}` (a chosen charge no longer open); VALIDATION_FAILED `{path: 'amount', code:
 *   'too_small' | 'exceeds_balance'}`; TX_CONFLICT (the year changed, or a number or charge was just taken)
 * @throws TypeError when the lock row of the year is absent (call ensureReceiptLockRow first)
 */
export async function takePayment(tx: TxCtx, i: PaymentInput): Promise<PaymentView> {
  const { trx } = tx;
  const name = receiptLockName(i.branchId, i.year);
  const lock = await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', name).executeTakeFirst();
  // MySQL/MariaDB report matched rows, not only changed ones: mysql2 connects with CLIENT_FOUND_ROWS.
  if (Number(lock.numUpdatedRows) !== 1) throw new TypeError(`takePayment(): the lock row ${name} is absent; call ensureReceiptLockRow() first`);
  const today = localDate(i.timeZone, tx.now);
  if (Number(today.slice(0, 4)) !== i.year) {
    throw new DomainError('TX_CONFLICT', { detail: 'Tahun kuitansi baru saja berganti; coba lagi / The receipt year just changed; try again' });
  }
  if (!(await lockLiveMember(trx, i.memberId))) throw memberNotFound();

  // The charges, locked in id order: the ones chosen, else every open one of the member at this branch.
  let ids: string[];
  if (i.chargeIds !== undefined) ids = [...i.chargeIds];
  else {
    const q = trx.selectFrom('charges').select('id').where('member_id', '=', i.memberId).where('branch_id', '=', i.branchId).where('status', '=', 'open').orderBy('id');
    ids = (await (locking(trx) ? q.forUpdate() : q).execute()).map((r) => r.id);
  }
  const rows = await lockCharges(trx, ids);
  if (i.chargeIds !== undefined) {
    if (rows.length !== ids.length || rows.some((r) => r.member_id !== i.memberId || r.branch_id !== i.branchId)) throw chargesNotFound();
    const closed = rows.find((r) => r.status !== 'open');
    if (closed !== undefined) throw chargeState(closed.status === 'cancelled' ? 'cancelled' : 'settled');
  }
  const open = rows.filter((r) => r.status === 'open' && chargeLeft(r) > 0).sort((a, b) => Number(a.charged_at) - Number(b.charged_at) || a.id.localeCompare(b.id));
  const amount = positiveAmount(i.amount);
  if (amount > open.reduce((sum, r) => sum + chargeLeft(r), 0)) throw memberValidationFailed([{ path: 'amount', code: 'exceeds_balance' }]);

  // The receipt number: the branch's code and the next sequence of the year.
  const branch = await trx.selectFrom('branches').select('code_display').where('id', '=', i.branchId).executeTakeFirstOrThrow();
  const top = await trx
    .selectFrom('payments')
    .select('receipt_seq')
    .where('branch_id', '=', i.branchId)
    .where('receipt_year', '=', i.year)
    .orderBy('receipt_seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const seq = (top?.receipt_seq === null || top?.receipt_seq === undefined ? 0 : Number(top.receipt_seq)) + 1;
  const receiptNo = receiptNumber(branch.code_display, i.year, seq);

  // The charges first, oldest first, then the payment and its allocations.
  const allocations: { chargeId: string; amount: number }[] = [];
  let rest = amount;
  for (const row of open) {
    if (rest === 0) break;
    const part = Math.min(rest, chargeLeft(row));
    const paid = Number(row.paid_minor) + part;
    const waived = Number(row.waived_minor);
    await writeChargeSums(tx, row, { paid, waived, status: chargeStatusOf(Number(row.amount_minor), paid, waived) });
    allocations.push({ chargeId: row.id, amount: part });
    rest -= part;
  }
  const id = newId(tx.now);
  try {
    await trx
      .insertInto('payments')
      .values({
        id,
        member_id: i.memberId,
        branch_id: i.branchId,
        receipt_year: i.year,
        receipt_seq: seq,
        receipt_no: receiptNo,
        amount_minor: amount,
        currency: open[0]!.currency,
        method: i.method,
        paid_on: today,
        paid_at: tx.now,
        received_by: tx.actor.id,
        note: i.note === undefined || i.note === '' ? null : i.note,
        voided_at: null,
        voided_by: null,
        void_reason: null,
        date_unknown: 0,
        source: 'desk',
        version: 0,
        created_at: tx.now,
        created_by: tx.actor.id,
        updated_at: tx.now,
        updated_by: tx.actor.id,
      })
      .execute();
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') throw numberTaken();
    throw error;
  }
  await trx
    .insertInto('payment_allocations')
    .values(allocations.map((a) => ({ payment_id: id, charge_id: a.chargeId, amount_minor: a.amount })))
    .execute();
  await tx.audit({ action: 'circulation.payment.create', entity: 'payments', entityId: id, branchId: i.branchId, meta: { method: i.method, charges: allocations.length } });
  const row = await trx.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return (await paymentViews(trx, [row]))[0]!;
}

/**
 * Voids the payment `paymentId` of the branch `branchId` with a reason and audits `circulation.payment.void`: what it
 * paid is owed again. Its receipt number is never used again.
 *
 * @throws DomainError NOT_FOUND (none at this branch); CIRC_CHARGE_STATE `{status: 'voided'}`; TX_CONFLICT
 */
export async function voidPayment(tx: TxCtx, i: { branchId: string; paymentId: string; reason: string }): Promise<PaymentView> {
  const { trx } = tx;
  const q = trx.selectFrom('payments').selectAll().where('id', '=', i.paymentId);
  const payment = await (locking(trx) ? q.forUpdate() : q).executeTakeFirst();
  if (payment === undefined || payment.branch_id !== i.branchId) throw paymentNotFound();
  await lockMemberRow(trx, payment.member_id);
  if (payment.voided_at !== null) throw chargeState('voided');
  const allocations = await trx.selectFrom('payment_allocations').select(['charge_id', 'amount_minor']).where('payment_id', '=', payment.id).execute();
  const back = new Map(allocations.map((a) => [a.charge_id, Number(a.amount_minor)]));
  for (const row of await lockCharges(trx, [...back.keys()])) {
    const part = back.get(row.id) ?? 0;
    const paid = Math.max(0, Number(row.paid_minor) - part);
    const waived = Number(row.waived_minor);
    await writeChargeSums(tx, row, { paid, waived, status: chargeStatusOf(Number(row.amount_minor), paid, waived) });
  }
  const done = await trx
    .updateTable('payments')
    .set({ voided_at: tx.now, voided_by: tx.actor.id, void_reason: i.reason, version: Number(payment.version) + 1, updated_at: tx.now, updated_by: tx.actor.id })
    .where('id', '=', payment.id)
    .where('version', '=', Number(payment.version))
    .where('voided_at', 'is', null)
    .executeTakeFirst();
  if (Number(done.numUpdatedRows) !== 1) throw chargeState('voided');
  await tx.audit({ action: 'circulation.payment.void', entity: 'payments', entityId: payment.id, branchId: i.branchId, meta: { method: payment.method, charges: allocations.length } });
  const row = await trx.selectFrom('payments').selectAll().where('id', '=', payment.id).executeTakeFirstOrThrow();
  return (await paymentViews(trx, [row]))[0]!;
}

// ---- the receipt -----------------------------------------------------------------------------------------------------

/** What a receipt prints. */
export interface ReceiptData {
  library: { name: string; address: string | null };
  branchName: string;
  member: { memberNo: string; name: string };
  payment: PaymentView;
  locale: Locale;
  paper: ReceiptPaper;
  footer: string | null;
  /** The time of the payment in the branch's time zone, `HH:MM`. */
  time: string;
}

/**
 * The receipt of the payment `paymentId` of the branch `branchId`, ready to print (`paper` default
 * `circulation.receipt.paperMm`).
 *
 * @throws DomainError NOT_FOUND (none at this branch)
 */
export async function receiptData(db: Db, i: { branchId: string; paymentId: string; paper?: ReceiptPaper }): Promise<ReceiptData> {
  const row = await db.selectFrom('payments').selectAll().where('id', '=', i.paymentId).executeTakeFirst();
  if (row === undefined || row.branch_id !== i.branchId) throw paymentNotFound();
  const s = await readSettings(db, ['library.name', 'library.address', 'library.locale', 'circulation.receipt.paperMm', 'circulation.receipt.footer.id', 'circulation.receipt.footer.en'], []);
  const locale: Locale = s['library.locale'] === 'en' ? 'en' : 'id';
  const branch = await db.selectFrom('branches').select(['name', 'code_display']).where('id', '=', row.branch_id).executeTakeFirst();
  const member = await db.selectFrom('members').select(['member_no_display', 'name']).where('id', '=', row.member_id).executeTakeFirst();
  const footer = s[locale === 'en' ? 'circulation.receipt.footer.en' : 'circulation.receipt.footer.id'];
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: await branchTimeZone(db, row.branch_id), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Number(row.paid_at));
  return {
    library: { name: s['library.name'] as string, address: (s['library.address'] as string | null) ?? null },
    branchName: branch === undefined ? '' : `${branch.name} (${branch.code_display})`,
    member: { memberNo: member?.member_no_display ?? '', name: member?.name ?? '' },
    payment: (await paymentViews(db, [row]))[0]!,
    locale,
    paper: i.paper ?? (String(s['circulation.receipt.paperMm']) === '58' ? '58' : '80'),
    footer: typeof footer === 'string' && footer.trim() !== '' ? footer : null,
    time,
  };
}

/** The receipt PDF of `d`: one page of a 58 or 80 mm roll. */
export function buildReceiptPdf(d: ReceiptData): Uint8Array {
  const tr = (key: Parameters<typeof t>[1]): string => t(d.locale, key);
  const narrow = d.paper === '58';
  const pdf = new PdfLayout({
    paper: narrow ? 'Roll58' : 'Roll80',
    orientation: 'portrait',
    marginsMm: { top: 4, right: 3, bottom: 4, left: 3 },
    title: tr('receipt.title'),
    header: null,
    footer: () => '',
    nonLatinNote: tr('receipt.non_latin'),
  });
  const p = d.payment;
  const size = narrow ? 7 : 8;
  pdf.paragraph(d.library.name, { bold: true, align: 'center', size: narrow ? 9 : 10 });
  if (d.library.address !== null && d.library.address.trim() !== '') pdf.paragraph(d.library.address, { align: 'center', size: narrow ? 6 : 7 });
  pdf.paragraph(tr('receipt.title'), { bold: true, align: 'center', size: narrow ? 9 : 10 });
  if (p.voided) pdf.paragraph(tr('receipt.voided'), { bold: true, align: 'center', size: narrow ? 9 : 10 });
  const rows: [string, string][] = [
    [tr('receipt.number'), p.receiptNo ?? '-'],
    [tr('receipt.date'), `${p.paidOn} ${d.time}`],
    [tr('receipt.branch'), d.branchName],
    [tr('receipt.member'), `${d.member.memberNo} ${d.member.name}`],
  ];
  pdf.keyValues(rows);
  pdf.paragraph(tr('receipt.items'), { bold: true, size });
  pdf.table(
    [{ header: tr('receipt.items'), weight: narrow ? 2 : 3 }, { header: p.currency, align: 'right' }],
    p.allocations.map((a) => [a.description, a.amount]),
  );
  pdf.keyValues([
    [tr('receipt.total'), `${p.currency} ${p.amount}`],
    [tr('receipt.method'), t(d.locale, `vocab.payment_method.${p.method}`)],
    [tr('receipt.staff'), p.receivedBy ?? '-'],
    ...(p.note === null ? [] : ([[tr('receipt.note'), p.note]] as [string, string][])),
  ]);
  if (d.footer !== null) pdf.paragraph(d.footer, { align: 'center', size });
  return pdf.toBytes();
}

// ---- the member's data -----------------------------------------------------------------------------------------------

// A member's payments are part of the member's own data; anonymising the member empties their free text (the note,
// the reason of a void), keeping the amounts, dates and receipt numbers as the financial record.
registerMemberDataSection({
  name: 'payments',
  read: async (db, memberId) => {
    const rows = await db
      .selectFrom('payments')
      .select(['receipt_no', 'amount_minor', 'currency', 'method', 'paid_on', 'note', 'voided_at', 'void_reason', 'source'])
      .where('member_id', '=', memberId)
      .orderBy('paid_at')
      .orderBy('id')
      .execute();
    return rows.map((p) => ({
      receiptNo: p.receipt_no,
      amountMinor: Number(p.amount_minor),
      currency: p.currency,
      method: p.method,
      paidOn: p.paid_on,
      note: p.note,
      voidedAt: p.voided_at === null ? null : Number(p.voided_at),
      voidReason: p.void_reason,
      source: p.source,
    }));
  },
});
registerMemberErasureStep({
  name: 'payments',
  run: async (tx, memberId) => {
    await tx.trx
      .updateTable('payments')
      .set({ note: null, void_reason: null })
      .where('member_id', '=', memberId)
      .where((eb) => eb.or([eb('note', 'is not', null), eb('void_reason', 'is not', null)]))
      .execute();
  },
});
