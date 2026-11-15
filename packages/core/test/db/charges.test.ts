import { withTx } from '@altis/db';
import { addDays, isDomainError } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  anonymizeLoanCharges,
  archiveMember,
  buildReceiptPdf,
  buildSlipPdf,
  createCalendarRule,
  createCharge,
  createMember,
  createPolicy,
  deskMemberView,
  ensureReceiptLockRow,
  lendItem,
  markLoanLost,
  memberCharges,
  openBalances,
  paymentSummary,
  receiptData,
  renewLoan,
  returnItem,
  slipData,
  takePayment,
  voidPayment,
  waiveCharge,
  type PaymentInput,
} from '../../src/index.js';
import { writeSettings } from '../../src/settings/service.js';
import { DAY, NOW, failure, fieldErrors, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Charges and payments on the engine picked by ALTIS_TEST_DB: the overdue fine (grace days, every day late, the cap,
// closed days of the loan branch's calendar left out or not), a late renewal and a lost item booking their fines, a lost
// item that comes back, manual charges, waives, payments spread oldest first with receipt numbers without gaps or
// repeats, voided payments, the optional blocks, the balance that keeps a member from being archived, and the lists.

const ctx = testDbContext();

/** NOW in Jakarta: Wednesday 2 September 2026. */
const TODAY = '2026-09-02';

type Settings = Parameters<typeof writeSettings>[1];

describe.skipIf(!ctx.available)(`charges and payments [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let guru: string;
  let seq = 0;

  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `CH-${seq}`, memberTypeId: siswa, name: `Anggota ${seq}`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }
  async function item(o: { price?: number | null } = {}): Promise<{ barcode: string; id: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Buku ${seq}` });
    const barcode = `CH-B-${seq}`;
    const id = await seedItem(db, recordId, { barcode });
    if (o.price !== undefined) await db.h.db.updateTable('items').set({ price: o.price, currency: 'IDR' }).where('id', '=', id).execute();
    return { barcode, id };
  }
  const at = (days: number): number => NOW + days * DAY;
  const lend = (memberId: string, barcode: string, now = NOW) => db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId, barcode }), now);
  const back = (barcode: string, days: number, foundLost = false) => db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode, foundLost }), at(days));
  const charges = (memberId: string) => db.h.db.selectFrom('charges').selectAll().where('member_id', '=', memberId).orderBy('charged_at').orderBy('id').execute();
  const settings = (patch: Settings) => withTx(db.h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  async function pay(memberId: string, amount: string, o: Partial<PaymentInput> = {}, days = 0) {
    const now = at(days);
    const year = Number(addDays(TODAY, days).slice(0, 4));
    await ensureReceiptLockRow(db.h, db.branchId, o.year ?? year);
    return db.run((tx) => takePayment(tx, { branchId: db.branchId, memberId, amount, method: 'cash', timeZone: 'Asia/Jakarta', year, ...o }), now);
  }

  beforeAll(async () => {
    db = await openItemsDb('charges');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    guru = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'GURU').executeTakeFirstOrThrow()).id;
    await db.h.db.updateTable('branches').set({ timezone: 'Asia/Jakarta' }).execute();
    // Pupils: 7 days, 500.00 a day after 2 grace days, at most 5 000.00, two renewals.
    await db.run((tx) =>
      createPolicy(tx, { code: 'SISWA-DENDA', name: 'Siswa', memberTypeId: siswa, loanDays: 7, loanLimit: null, renewLimit: 2, finePerDay: '500', fineCap: '5000', graceDays: 2 } as never),
    );
  });
  afterAll(async () => {
    await db?.close();
  });

  it('the overdue fine: nothing within the grace days, then every day late times the rate, at most the cap', async () => {
    const due = addDays(TODAY, 7);
    const cases: [number, number | null][] = [
      [0, null], // on time
      [2, null], // within the grace days
      [3, 150_000], // three days late: 3 × 500.00, not only the day past the grace
      [9, 450_000],
      [30, 500_000], // capped at 5 000.00
    ];
    for (const [late, fine] of cases) {
      const reader = await member();
      const book = await item();
      const loan = await lend(reader, book.barcode);
      expect(loan.dueOn).toBe(due);
      const returned = await back(book.barcode, 7 + late);
      expect(returned.daysLate).toBe(late);
      expect(returned.finedDays).toBe(fine === null ? undefined : late);
      const rows = await charges(reader);
      expect(rows.map((r) => Number(r.amount_minor))).toEqual(fine === null ? [] : [fine]);
      if (fine !== null) {
        expect(rows[0]).toMatchObject({ kind: 'overdue', loan_id: loan.id, item_id: book.id, status: 'open', source: 'system', charged_on: addDays(due, late), currency: 'IDR' });
        expect(rows[0]!.description).toContain(book.barcode);
      }
    }
  });

  it('closed days of the loan branch are left out of the days late, unless the library counts them', async () => {
    // Sundays closed: due Wednesday 9 September, back Monday 14 September = 5 days, 4 of them open.
    const sunday = (await db.run((tx) => createCalendarRule(tx, { name: 'Minggu', kind: 'weekly', weekday: 7 }))).id;
    const reader = await member();
    const book = await item();
    await lend(reader, book.barcode);
    // The return says both: the calendar days late and the days its fine counted.
    expect(await back(book.barcode, 12)).toMatchObject({ daysLate: 5, finedDays: 4 });
    expect((await charges(reader)).map((r) => Number(r.amount_minor))).toEqual([200_000]);

    await settings({ 'circulation.fines.skipClosedDays': false } as Settings);
    const other = await member();
    const second = await item();
    await lend(other, second.barcode);
    expect(await back(second.barcode, 12)).toMatchObject({ daysLate: 5, finedDays: 5 });
    expect((await charges(other)).map((r) => Number(r.amount_minor))).toEqual([250_000]);
    await settings({ 'circulation.fines.skipClosedDays': true } as Settings);
    await db.h.db.updateTable('calendars').set({ archived_at: NOW }).where('id', '=', sunday).execute();
  });

  it('a late renewal books the fine up to that day from the old due date; the loan goes on', async () => {
    const reader = await member();
    const book = await item();
    const loan = await lend(reader, book.barcode);
    const renewed = await db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId: loan.id }), at(12));
    expect(renewed.dueOn).toBe(addDays(TODAY, 19));
    expect((await charges(reader)).map((r) => [r.kind, Number(r.amount_minor), r.charged_on])).toEqual([['overdue', 250_000, addDays(TODAY, 12)]]);
    // Back on time under the new due date: nothing more.
    await back(book.barcode, 15);
    expect(await charges(reader)).toHaveLength(1);
  });

  it('a lost item books the fine, the replacement and the fee; when it comes back the unpaid replacement is cancelled', async () => {
    await settings({ 'circulation.lost.processingFeeMinor': 1_000_000 } as Settings);
    const reader = await member();
    const book = await item({ price: 8_500_000 });
    const loan = await lend(reader, book.barcode);
    const lost = await db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: loan.id }), at(10));
    expect(lost).toMatchObject({ charged: true, replacement: '85000.00' });
    const rows = await charges(reader);
    expect(rows.map((r) => [r.kind, Number(r.amount_minor)])).toEqual([
      ['overdue', 150_000],
      ['lost', 8_500_000],
      ['lost', 1_000_000],
    ]);
    // Part of the replacement is paid, then the item comes back: the rest of both lost charges is cancelled.
    await pay(reader, '20000', { chargeIds: [rows[1]!.id] }, 11);
    const found = await back(book.barcode, 12, true);
    expect(found.foundLost).toBe(true);
    const after = await charges(reader);
    expect(after.map((r) => [r.kind, r.status, Number(r.paid_minor), Number(r.waived_minor)])).toEqual([
      ['overdue', 'open', 0, 0],
      ['lost', 'settled', 2_000_000, 6_500_000],
      ['lost', 'cancelled', 0, 1_000_000],
    ]);
    const adjustments = await db.h.db.selectFrom('charge_adjustments').select(['kind', 'amount_minor']).where('charge_id', 'in', [after[1]!.id, after[2]!.id]).orderBy('amount_minor').execute();
    expect(adjustments.map((a) => [a.kind, Number(a.amount_minor)])).toEqual([
      ['cancel', 1_000_000],
      ['cancel', 6_500_000],
    ]);
    await settings({ 'circulation.lost.processingFeeMinor': 0 } as Settings);
  });

  it('payments: oldest charge first, never more than is owed, receipts numbered without gaps; a voided payment is owed again', async () => {
    const reader = await member();
    const one = await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'card', amount: '5000', description: 'Kartu baru' }), at(1));
    const two = await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'damage', amount: '12500.50', description: 'Sampul sobek' }), at(2));
    expect(two).toMatchObject({ amount: '12500.50', balance: '12500.50', status: 'open', source: 'desk' });
    expect(await fieldErrors(pay(reader, '17500.51'))).toEqual([{ path: 'amount', code: 'exceeds_balance' }]);
    expect(await fieldErrors(pay(reader, '0'))).toEqual([{ path: 'amount', code: 'too_small' }]);

    const before = Number((await db.h.db.selectFrom('payments').select('receipt_seq').where('branch_id', '=', db.branchId).orderBy('receipt_seq', 'desc').executeTakeFirst())?.receipt_seq ?? 0);
    const first = await pay(reader, '7000', { method: 'transfer' }, 3);
    expect(first.receiptNo).toBe(`PUSAT/2026/${String(before + 1).padStart(6, '0')}`);
    expect(first.allocations.map((a) => [a.chargeId, a.amount])).toEqual([
      [one.id, '5000.00'],
      [two.id, '2000.00'],
    ]);
    const second = await pay(reader, '10500.50', {}, 3);
    expect(second.receiptNo).toBe(`PUSAT/2026/${String(before + 2).padStart(6, '0')}`);
    expect((await charges(reader)).map((r) => r.status)).toEqual(['settled', 'settled']);
    expect(await failure(pay(reader, '1'))).toMatchObject({ code: 'VALIDATION_FAILED' });

    // Voiding the first payment: both charges are owed again; its number is never reused.
    const voided = await db.run((tx) => voidPayment(tx, { branchId: db.branchId, paymentId: first.id, reason: 'Salah nominal' }), at(3));
    expect(voided).toMatchObject({ voided: true, voidReason: 'Salah nominal' });
    expect((await charges(reader)).map((r) => [r.status, Number(r.paid_minor)])).toEqual([
      ['open', 0],
      ['open', 1_050_050],
    ]);
    expect(await failure(db.run((tx) => voidPayment(tx, { branchId: db.branchId, paymentId: first.id, reason: 'Lagi' })))).toMatchObject({
      code: 'CIRC_CHARGE_STATE',
      meta: { status: 'voided' },
    });
    const third = await pay(reader, '7000', {}, 4);
    expect(third.receiptNo).toBe(`PUSAT/2026/${String(before + 3).padStart(6, '0')}`);

    // Another branch's payment or charge is not found there; a charge chosen at another branch neither.
    expect(await failure(db.run((tx) => voidPayment(tx, { branchId: db.otherBranchId, paymentId: third.id, reason: 'x' })))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await failure(db.run((tx) => waiveCharge(tx, { branchId: db.otherBranchId, chargeId: one.id, reason: 'x' })))).toMatchObject({ code: 'NOT_FOUND' });

    // The receipt prints on both rolls.
    const data = await receiptData(db.h.db, { branchId: db.branchId, paymentId: third.id, paper: '58' });
    expect(data.member.memberNo).toMatch(/^CH-\d+$/);
    for (const paper of ['58', '80'] as const) expect(Buffer.from(buildReceiptPdf({ ...data, paper })).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // A new year starts again at 1; a year that changed after the route worked it out is TX_CONFLICT.
    await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'manual', amount: '100', description: 'Fotokopi' }), at(5));
    expect(await failure(pay(reader, '50', { year: 2027 }, 4))).toMatchObject({ code: 'TX_CONFLICT' });
    // The audit log refuses entries far ahead of the clock: the clock moves to the new year too.
    vi.useFakeTimers({ toFake: ['Date'], now: at(122) });
    try {
      const nextYear = await pay(reader, '50', {}, 121);
      expect(nextYear.receiptNo).toBe('PUSAT/2027/000001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two payments of the same charge at once: one is taken, the other exceeds what is left', async () => {
    const reader = await member();
    await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'manual', amount: '3000', description: 'Denda lama' }));
    const both = await Promise.all([pay(reader, '3000'), pay(reader, '3000')].map((p) => failure(p.then(() => 'paid'))));
    const outcomes = both.map((o) => (o === 'resolved' ? 'paid' : (o as { code: string }).code)).sort();
    expect(outcomes).toEqual(['VALIDATION_FAILED', 'paid']);
    const rows = await charges(reader);
    expect(rows.map((r) => [Number(r.paid_minor), r.status])).toEqual([[300_000, 'settled']]);
    const seqs = (await db.h.db.selectFrom('payments').select('receipt_seq').where('branch_id', '=', db.branchId).where('receipt_year', '=', 2026).orderBy('receipt_seq').execute()).map((r) => Number(r.receipt_seq));
    expect(seqs).toEqual(seqs.map((_, k) => k + 1));
  });

  it('waives: part or all of what is left, never more; a settled charge is CIRC_CHARGE_STATE; paid + waived never passes the amount', async () => {
    const reader = await member();
    const c = await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'damage', amount: '10000', description: 'Basah' }));
    expect(await fieldErrors(db.run((tx) => waiveCharge(tx, { branchId: db.branchId, chargeId: c.id, amount: '10000.01', reason: 'x' })))).toEqual([
      { path: 'amount', code: 'exceeds_balance' },
    ]);
    const part = await db.run((tx) => waiveCharge(tx, { branchId: db.branchId, chargeId: c.id, amount: '2500', reason: 'Kurang mampu' }));
    expect(part).toMatchObject({ waived: '2500.00', balance: '7500.00', status: 'open' });
    await pay(reader, '5000');
    const rest = await db.run((tx) => waiveCharge(tx, { branchId: db.branchId, chargeId: c.id, reason: 'Sisa dihapuskan' }));
    expect(rest).toMatchObject({ paid: '5000.00', waived: '5000.00', balance: '0.00', status: 'settled' });
    expect(await failure(db.run((tx) => waiveCharge(tx, { branchId: db.branchId, chargeId: c.id, reason: 'x' })))).toMatchObject({
      code: 'CIRC_CHARGE_STATE',
      meta: { status: 'settled' },
    });
    for (const r of await db.h.db.selectFrom('charges').selectAll().execute()) {
      expect(Number(r.paid_minor) + Number(r.waived_minor)).toBeLessThanOrEqual(Number(r.amount_minor));
      expect(Number(r.paid_minor)).toBeGreaterThanOrEqual(0);
    }
    const listed = await memberCharges(db.h.db, reader, { status: 'all' });
    expect(listed.adjustments.map((a) => [a.kind, a.amount])).toEqual([
      ['waive', '2500.00'],
      ['waive', '2500.00'],
    ]);
  });

  it('the optional blocks: a balance above the limit refuses loans and renewals, an overdue loan refuses loans; forced as blocked', async () => {
    const reader = await member({ memberTypeId: guru });
    const book = await item();
    const loan = await lend(reader, book.barcode);
    await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: reader, kind: 'manual', amount: '20000', description: 'Lama' }));
    await settings({ 'circulation.block.unpaidOverMinor': 1_000_000 } as Settings);
    expect(await failure(lend(reader, (await item()).barcode))).toMatchObject({ code: 'CIRC_MEMBER_BLOCKED', meta: { reason: 'unpaid' } });
    expect(await failure(db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId: loan.id }), at(1)))).toMatchObject({
      code: 'CIRC_RENEW_REFUSED',
      meta: { reason: 'blocked' },
    });
    const panel = await deskMemberView(db.h.db, { branchId: db.branchId, memberId: reader }, NOW);
    expect([panel.borrowRefusal, panel.charges.blocked, panel.charges.balance]).toEqual(['CIRC_MEMBER_BLOCKED', 'unpaid', '20000.00']);
    const other = await item();
    const ok = await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: reader, barcode: other.barcode, override: { reasons: ['blocked'], note: 'Izin kepala' } }));
    expect(ok.overrides).toEqual(['blocked']);
    await settings({ 'circulation.block.unpaidOverMinor': null, 'circulation.block.overdue': true } as Settings);
    expect(await failure(lend(reader, (await item()).barcode, at(10)))).toMatchObject({ code: 'CIRC_MEMBER_BLOCKED', meta: { reason: 'overdue' } });
    await settings({ 'circulation.block.overdue': false } as Settings);
  });

  it('a member with a balance cannot be archived; the desk previews running fines; the lists and the cash summary', async () => {
    const reader = await member();
    const book = await item();
    await lend(reader, book.barcode);
    const panel = await deskMemberView(db.h.db, { branchId: db.branchId, memberId: reader }, at(10));
    expect(panel.loans[0]!.finePreview).toEqual({ amount: '1500.00', currency: 'IDR', days: 3 });
    await back(book.barcode, 10);
    const archive = await failure(db.run((tx) => archiveMember(tx, reader, 0)));
    expect(archive).toMatchObject({ code: 'MEMBER_IN_USE', meta: { openLoans: 0, balanceMinor: 150_000 } });

    const open = await openBalances(db.h.db, { branchId: db.branchId });
    expect(open.items.find((x) => x.member.id === reader)).toMatchObject({ balance: '1500.00', openCharges: 1 });
    await pay(reader, '1000', { method: 'cash' }, 10);
    await pay(reader, '500', { method: 'other' }, 10);
    const day = addDays(TODAY, 10);
    const summary = await paymentSummary(db.h.db, { branchId: db.branchId, from: day, to: day }, NOW);
    expect(summary.days.map((d) => d.day)).toEqual([day]);
    expect(summary.all.byMethod.other).toBe('500.00');
    expect(Number(summary.all.byMethod.cash)).toBeGreaterThanOrEqual(1000);
    expect(isDomainError(await paymentSummary(db.h.db, { from: '2026-01-01', to: '2027-01-02' }, NOW).catch((e: unknown) => e))).toBe(true);

    // The visit's slip: the late return with its fine and the payments; another branch's slip finds none of them.
    const loanId = (await db.h.db.selectFrom('loans').select('id').where('member_id', '=', reader).executeTakeFirstOrThrow()).id;
    const paid = (await db.h.db.selectFrom('payments').select('id').where('member_id', '=', reader).execute()).map((p) => p.id);
    const slip = await slipData(db.h.db, { branchId: db.branchId, loanIds: [], returnedLoanIds: [loanId], paymentIds: paid, now: at(10) });
    expect(slip.returns).toEqual([{ barcode: book.barcode, title: expect.any(String), returnedOn: day, daysLate: 3, fine: '1500.00' }]);
    expect(slip.payments.map((p) => p.amount)).toEqual(['1000.00', '500.00']);
    expect(slip.member?.memberNo).toMatch(/^CH-/);
    for (const paper of ['58', '80'] as const) expect(Buffer.from(buildSlipPdf({ ...slip, paper })).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await failure(slipData(db.h.db, { branchId: db.otherBranchId, loanIds: [loanId], returnedLoanIds: [], paymentIds: [], now: NOW }))).toMatchObject({ code: 'NOT_FOUND' });

    // Anonymising the loan: its settled fine loses the loan, the item and the line; the sums stay.
    expect(await withTx(db.h, (trx) => anonymizeLoanCharges(trx, [loanId], NOW))).toBe(1);
    expect((await charges(reader)).map((r) => [r.loan_id, r.item_id, r.description, r.status, Number(r.amount_minor)])).toEqual([[null, null, '', 'settled', 150_000]]);
  });
});

