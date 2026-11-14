import { auditAppend, withTx } from '@altis/db';
import { t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { circulationDaySummary } from '../../src/circulation/day-summary.js';
import { reportById } from '../../src/reports/registry.js';
import { previewReport } from '../../src/reports/runs/preview.js';
import type { ReportRow } from '../../src/reports/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import {
  masterId,
  seedBranch,
  seedCharge,
  seedCopy,
  seedHold,
  seedLoan,
  seedMember,
  seedPayment,
  seedUse,
  seedVisit,
} from '../support/circulation-seed.js';
import { STAFF_NAME, openExportDb, type ExportDb } from './reports-export-support.js';

// The member, visit and circulation reports on a small library seen on 15 March 2026 (Asia/Jakarta): the numbers each
// report answers, worked out by hand. Loans counted once in the month they were lent and never when voided; the idle
// active members never negative; the running fine of an overdue loan in whole minor units; the queue positions of
// waiting holds; the cash book without the voided payment; visits by head count without the voided one.

const ctx = testDbContext();
const NOW = Date.parse('2026-03-15T05:00:00Z');
const row = (key: string, params?: Record<string, string>) => t('id', `report.row.circ.${key}` as MessageKey, params);
const section = (key: string) => t('id', `report.section.circ.${key}` as MessageKey);
const TOTAL = t('id', 'report.row.total');

describe.skipIf(!ctx.available)(`member, visit and circulation reports [${engineLabel()}]`, () => {
  let db: ExportDb;
  let branchId: string;
  let otherBranch: string;
  let siswa: string;
  const ids: Record<string, string> = {};

  /** Every row of a report for `params` at NOW, and its totals. */
  async function preview(id: string, params: Record<string, unknown> = {}): Promise<{ rows: ReportRow[]; totals: ReportRow | null }> {
    const def = reportById(id)!;
    const settings = await loadAccredSettings(db.h.db);
    const o = { locale: 'id' as const, tz: 'Asia/Jakarta', now: NOW, settings };
    const rows: ReportRow[] = [];
    let page = await previewReport(db.h.db, def, { params, limit: 200 }, o);
    const totals = page.totals;
    rows.push(...page.rows);
    while (page.nextCursor !== null) {
      page = await previewReport(db.h.db, def, { params, limit: 200, cursor: page.nextCursor }, o);
      rows.push(...page.rows);
    }
    return { rows, totals };
  }

  beforeAll(async () => {
    db = await openExportDb('circ-reports');
    const h = db.h.db;
    branchId = await seedBranch(h, 'UT');
    otherBranch = await seedBranch(h, 'CB');
    siswa = await masterId(h, 'member_types', 'SISWA');
    // Members: two borrowers, one idle active, one expired, one suspended, one archived, one expiring soon.
    ids.ana = await seedMember(h, { no: 'S-001', name: 'Ana', className: 'X-1', phone: '0811', joinedOn: '2026-01-10' });
    ids.budi = await seedMember(h, { no: 'S-002', name: 'Budi', className: 'X-2', joinedOn: '2026-03-02' });
    ids.cici = await seedMember(h, { no: 'S-003', name: 'Cici', className: 'X-1' });
    ids.dodi = await seedMember(h, { no: 'S-004', name: 'Dodi', expiresOn: '2026-03-01' });
    ids.eka = await seedMember(h, { no: 'G-001', name: 'Eka', typeCode: 'GURU', status: 'suspended' });
    await seedMember(h, { no: 'S-005', name: 'Fajar', archived: true });
    ids.gita = await seedMember(h, { no: 'S-006', name: 'Gita', expiresOn: '2026-04-01' });
    // Copies.
    const bio = await seedCopy(h, { branchId, title: 'Biologi Dasar', barcode: 'B0001', classification: '570', price: 7_500_000 });
    const tafsir = await seedCopy(h, { branchId, title: 'Tafsir Ringkas', barcode: 'B0002', classification: '2X1', price: null });
    const novel = await seedCopy(h, { branchId, title: 'Laskar Pelangi', barcode: 'B0003', classification: 'FIK', price: 9_000_000 });
    const bio2 = await seedCopy(h, { branchId, title: 'Biologi Lanjut', barcode: 'B0004', classification: '574' });
    Object.assign(ids, { bioRecord: bio.recordId, bioItem: bio.itemId });
    // Loans of March (the range 1–15 March): three counted, one voided, one returned in the range.
    await seedLoan(h, { ...bio, memberId: ids.ana, branchId, loanedOn: '2026-03-03', dueOn: '2026-03-10', statDdc: '570', memberTypeId: siswa, className: 'X-1', finePerDayMinor: 50_000 });
    await seedLoan(h, { ...tafsir, memberId: ids.ana, branchId, loanedOn: '2026-03-03', dueOn: '2026-03-17', statDdc: '2X', memberTypeId: siswa, renewals: 1, loanedAt: Date.parse('2026-03-03T02:00:00Z') });
    await seedLoan(h, { ...novel, memberId: ids.budi, branchId, loanedOn: '2026-03-05', dueOn: '2026-03-12', returnedOn: '2026-03-11', statDdc: null, memberTypeId: siswa });
    await seedLoan(h, { ...novel, memberId: ids.budi, branchId, loanedOn: '2026-03-12', dueOn: '2026-03-19', outcome: 'voided', returnedOn: '2026-03-12', statDdc: null });
    // February: one loan of the second biology title, returned; another branch's loan of March.
    await seedLoan(h, { ...bio2, memberId: ids.budi, branchId, loanedOn: '2026-02-20', dueOn: '2026-02-27', returnedOn: '2026-02-26', statDdc: '570', memberTypeId: siswa });
    const other = await seedCopy(h, { branchId: otherBranch, title: 'Atlas Dunia', barcode: 'C0001', classification: '912' });
    await seedLoan(h, { ...other, memberId: ids.cici, branchId: otherBranch, loanedOn: '2025-12-30', dueOn: '2026-01-06', returnedOn: '2026-01-05', statDdc: '910' });
    // In-library uses.
    await seedUse(h, { ...bio, branchId, usedOn: '2026-03-04', statDdc: '570' });
    await seedUse(h, { ...tafsir, branchId, usedOn: '2026-03-04', statDdc: '2X' });
    // Visits of March: a member, a class of 30, a guest, and a voided one.
    await seedVisit(h, { branchId, visitedOn: '2026-03-02', memberId: ids.ana, memberTypeId: siswa, className: 'X-1' });
    await seedVisit(h, { branchId, visitedOn: '2026-03-02', memberTypeId: siswa, accredGroup: 'student', className: 'X-2', source: 'manual', headcount: 30 });
    await seedVisit(h, { branchId, visitedOn: '2026-03-15', guestName: 'Pak Tamu', source: 'manual' });
    await seedVisit(h, { branchId, visitedOn: '2026-03-15', memberId: ids.budi, memberTypeId: siswa, voided: true });
    // Holds: two waiting on the biology title (placed in that order), one ready.
    await seedHold(h, { recordId: bio.recordId, memberId: ids.budi, branchId, placedOn: '2026-03-06' });
    await seedHold(h, { recordId: bio.recordId, memberId: ids.cici, branchId, placedOn: '2026-03-07' });
    await seedHold(h, { recordId: novel.recordId, memberId: ids.ana, branchId, placedOn: '2026-03-08', status: 'ready', pickupUntil: '2026-03-16' });
    // Charges and payments (minor units).
    await seedCharge(h, { memberId: ids.ana, branchId, amountMinor: 1_000_000, paidMinor: 400_000, chargedOn: '2026-03-11' });
    await seedCharge(h, { memberId: ids.budi, branchId, amountMinor: 250_000, waivedMinor: 250_000, chargedOn: '2026-03-12', kind: 'damage', description: 'Sampul rusak' });
    await seedPayment(h, { memberId: ids.ana, branchId, amountMinor: 400_000, paidOn: '2026-03-11', staffId: db.staffId, seq: 1 });
    await seedPayment(h, { memberId: ids.ana, branchId, amountMinor: 100_000, paidOn: '2026-03-11', staffId: db.staffId, seq: 2, voided: true });
    await seedPayment(h, { memberId: ids.budi, branchId, amountMinor: 300_000, paidOn: '2026-03-12', method: 'transfer', staffId: db.staffId, seq: 3 });
    // Renewals, as the desk and the member area audit them: two in the range (one late in the evening of the 15th, local
    // time), one at the other branch, one the day after the range.
    for (const [at, branch] of [
      ['2026-03-04T03:00:00Z', branchId],
      ['2026-03-15T16:30:00Z', branchId],
      ['2026-03-05T03:00:00Z', otherBranch],
      ['2026-03-15T17:30:00Z', branchId],
    ] as const) {
      await withTx(db.h, (trx) =>
        auditAppend(trx, { at: Date.parse(at), actorType: 'staff', actorId: db.staffId, action: 'circulation.loan.renew', entity: 'loans', entityId: null, branchId: branch, ip: null, meta: {} }),
      );
    }
    // A migrated member whose SLiMS number collided with another after normalisation.
    await seedMember(h, { no: 'B001-2', name: 'Hana', source: 'slims:b 001' });
    await seedMember(h, { no: 'B001', name: 'Indra', source: 'slims:B001' });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('circulation.summary: loans, returns, borrowers, per open day, the busiest day, overdue, idle members, by class', async () => {
    const { rows } = await preview('circulation.summary', { range: { from: '2026-03-01', to: '2026-03-15' }, branchId });
    const totals = rows.filter((r) => r[0] === section('totals'));
    expect(totals).toEqual([
      [section('totals'), row('loans'), 3],
      [section('totals'), row('returns'), 1],
      [section('totals'), row('renewals'), 2],
      [section('totals'), row('borrowers'), 2],
      [section('totals'), row('per_open_day'), 0.2],
      [section('totals'), row('busiest_day', { date: '2026-03-03' }), 2],
      [section('totals'), row('overdue_open'), 1],
      // Cici, Gita, Hana and Indra are active and borrowed nothing here in the range (Dodi expired, Eka suspended).
      [section('totals'), row('active_not_borrowing'), 4],
    ]);
    const byClass = new Map(rows.filter((r) => r[0] === section('by_class')).map((r) => [String(r[1]).slice(0, 3), r[2]]));
    expect([byClass.get('500'), byClass.get('2X '), byClass.get('NON'), byClass.get('900')]).toEqual([1, 1, 1, 0]);
    expect(rows.filter((r) => r[0] === section('by_material_type')).map((r) => r[2])).toEqual([3]);
  });

  it('circulation.summary never counts an idle member below zero, whatever the range', async () => {
    const { rows } = await preview('circulation.summary', { range: { from: '2020-01-01', to: '2026-03-15' } });
    // Every active member but Ana, Budi and Cici (who borrowed at the other branch in 2025).
    const idle = rows.find((r) => r[1] === row('active_not_borrowing'))!;
    expect(idle[2]).toBe(3);
  });

  it('circulation.loans_by_class: a loan once in the month it was lent, never voided, by its class; one class by division', async () => {
    const { rows, totals } = await preview('circulation.loans_by_class', { year: 2026, branchId });
    expect(rows).toHaveLength(12);
    // Columns: month, c000…c900, c2x, cnon, total.
    expect(rows[1]).toEqual(['2026-02', 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(rows[2]).toEqual(['2026-03', 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 3]);
    expect(totals).toEqual([TOTAL, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 4]);
    const divisions = await preview('circulation.loans_by_class', { year: 2026, mainClass: '500' });
    expect(divisions.rows.map((r) => r[0])).toEqual(['500–509', '510–519', '520–529', '530–539', '540–549', '550–559', '560–569', '570–579', '580–589', '590–599']);
    expect(divisions.rows[7]).toEqual(['570–579', 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    const lastYear = await preview('circulation.loans_by_class', { year: 2025 });
    expect(lastYear.totals).toEqual([TOTAL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1]);
  });

  it('circulation.in_library and item_usage count by month', async () => {
    const uses = await preview('circulation.in_library', { year: 2026 });
    expect(uses.rows[2]).toEqual(['2026-03', 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2]);
    const usage = await preview('circulation.item_usage', { year: 2026, minLoans: 1 });
    expect(usage.rows.map((r) => [r[0], r[3], r[4], r[14]])).toEqual([
      ['B0001', 0, 1, 1],
      ['B0002', 0, 1, 1],
      ['B0003', 0, 1, 1],
      ['B0004', 1, 0, 1],
    ]);
    expect((await preview('circulation.item_usage', { year: 2026, search: 'biologi' })).rows.map((r) => r[0])).toEqual(['B0001', 'B0004']);
  });

  it('circulation.top_titles and top_borrowers: most first, the voided loan left out', async () => {
    const titles = await preview('circulation.top_titles', { range: { from: '2026-01-01', to: '2026-03-15' } });
    expect(titles.rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      [1, 'Biologi Dasar', 1],
      [2, 'Biologi Lanjut', 1],
      [3, 'Laskar Pelangi', 1],
      [4, 'Tafsir Ringkas', 1],
    ]);
    const borrowers = await preview('circulation.top_borrowers', { range: { from: '2026-01-01', to: '2026-03-15' } });
    expect(borrowers.rows.map((r) => [r[0], r[1], r[5]])).toEqual([
      [1, 'S-001', 2],
      [2, 'S-002', 2],
    ]);
  });

  it('circulation.overdue: the running fine in whole units; due_soon within N days; open_loans by member', async () => {
    const overdue = await preview('circulation.overdue');
    // Due 10 March, five days late on the 15th, Rp 500 a day: Rp 2 500; the price Rp 75 000.
    expect(overdue.rows).toEqual([['S-001', 'Ana', 'X-1', '0811', null, 'B0001', 'Biologi Dasar', 75_000, '2026-03-03', '2026-03-10', 5, 2_500]]);
    expect((await preview('circulation.overdue', { minDaysLate: 6 })).rows).toEqual([]);
    const soon = await preview('circulation.due_soon', { days: 3 });
    expect(soon.rows.map((r) => [r[5], r[9]])).toEqual([['B0002', 2]]);
    expect((await preview('circulation.due_soon', { days: 1 })).rows).toEqual([]);
    const open = await preview('circulation.open_loans');
    expect(open.rows.map((r) => [r[0], r[5], r[9]])).toEqual([
      ['S-001', 'B0001', 5],
      ['S-001', 'B0002', 0],
    ]);
    expect((await preview('circulation.open_loans', { overdueOnly: true })).rows).toHaveLength(1);
  });

  it('circulation.loan_history: newest first, the voided loan left out, the state and days late', async () => {
    const { rows } = await preview('circulation.loan_history', { branchId });
    expect(rows.map((r) => [r[4], r[10], r[11]])).toEqual([
      ['B0003', t('id', 'vocab.loan_outcome.returned'), 0],
      ['B0001', t('id', 'vocab.loan_state.open'), 5],
      ['B0002', t('id', 'vocab.loan_state.open'), 0],
      ['B0004', t('id', 'vocab.loan_outcome.returned'), 0],
    ]);
    expect((await preview('circulation.loan_history', { member: 'S-002' })).rows.map((r) => r[4])).toEqual(['B0003', 'B0004']);
    expect((await preview('circulation.loan_history', { loanState: 'open' })).rows).toHaveLength(2);
  });

  it('circulation.holds: the queue position of each waiting hold, none for a ready one', async () => {
    const { rows } = await preview('circulation.holds');
    expect(rows.map((r) => [r[1], r[5], r[6]])).toEqual([
      ['S-001', null, '2026-03-16'],
      ['S-003', 2, null],
      ['S-002', 1, null],
    ]);
    expect((await preview('circulation.holds', { holdStatus: ['ready'] })).rows).toHaveLength(1);
  });

  it('circulation.charges and payments_daily: what is left, and the cash book without the voided payment', async () => {
    const charges = await preview('circulation.charges');
    expect(charges.rows.map((r) => [r[0], r[5], r[6], r[7], r[8]])).toEqual([
      ['S-001', 10_000, 4_000, 0, 6_000],
      ['S-002', 2_500, 0, 2_500, 0],
    ]);
    expect(charges.totals).toEqual([TOTAL, null, null, null, null, 12_500, 4_000, 2_500, 6_000]);
    const days = await preview('circulation.payments_daily', { range: { from: '2026-03-01', to: '2026-03-15' } });
    expect(days.rows).toEqual([
      ['2026-03-11', t('id', 'vocab.payment_method.cash'), STAFF_NAME, 1, 4_000],
      ['2026-03-12', t('id', 'vocab.payment_method.transfer'), STAFF_NAME, 1, 3_000],
    ]);
    expect(days.totals).toEqual([TOTAL, null, null, null, 7_000]);
    const receipts = await preview('circulation.payments_daily', { range: { from: '2026-03-01', to: '2026-03-15' }, view: 'receipts' });
    expect(receipts.rows.map((r) => [r[1], r[6], r[7]])).toEqual([
      ['UT/2026/000001', 4_000, null],
      ['UT/2026/000002', 1_000, row('voided')],
      ['UT/2026/000003', 3_000, null],
    ]);
  });

  it('visits.monthly, visits.daily and visits.list: head counts, the guest row, the voided visit left out', async () => {
    const monthly = await preview('visits.monthly', { year: 2026 });
    expect(monthly.rows.map((r) => [r[0], r[3], r[13]])).toEqual([
      ['Siswa', 31, 31],
      [row('guests'), 1, 1],
    ]);
    const byClass = await preview('visits.monthly', { year: 2026, rowsBy: 'class' });
    expect(byClass.rows.map((r) => [r[0], r[13]])).toEqual([
      ['X-1', 1],
      ['X-2', 30],
      [row('guests'), 1],
    ]);
    const daily = await preview('visits.daily', { year: 2026, month: 3 });
    expect(daily.rows).toHaveLength(31);
    expect(daily.rows[1]).toEqual(['2026-03-02', t('id', 'report.weekday.1' as MessageKey), 31, 0, 31]);
    expect(daily.totals).toEqual([TOTAL, null, 31, 1, 32]);
    const list = await preview('visits.list', { guestsOnly: true });
    expect(list.rows.map((r) => [r[1], r[2]])).toEqual([[row('guest'), 'Pak Tamu']]);
  });

  it('members.summary, members.expiring and members.reprint_list', async () => {
    const summary = await preview('members.summary');
    const byType = summary.rows.filter((r) => r[0] === section('members_by_type'));
    // SISWA: Ana, Budi, Cici, Dodi (expired), Gita, Hana, Indra; GURU: Eka (suspended); every live type listed.
    expect(byType.find((r) => r[1] === 'Siswa')).toEqual([section('members_by_type'), 'Siswa', 7, 6, 1, 0]);
    expect(byType.find((r) => r[1] === 'Guru')).toEqual([section('members_by_type'), 'Guru', 1, 0, 0, 1]);
    expect(byType.length).toBeGreaterThanOrEqual(4);
    const joined = summary.rows.filter((r) => r[0] === section('members_new'));
    expect(joined).toHaveLength(12);
    expect(joined.at(-1)).toEqual([section('members_new'), row('joined_in', { month: '2026-03' }), 1, null, null, null]);
    expect(summary.totals).toEqual([TOTAL, null, 8, 6, 1, 1]);
    const expiring = await preview('members.expiring', { days: 30 });
    expect(expiring.rows.map((r) => [r[0], r[5]])).toEqual([
      ['S-004', -14],
      ['S-006', 17],
    ]);
    const reprint = await preview('members.reprint_list');
    expect(reprint.rows).toEqual([['b 001', 'B001-2', 'Hana']]);
  });

  it('the dashboard numbers of today at a branch', async () => {
    expect(await circulationDaySummary(db.h.db, branchId, Date.parse('2026-03-03T05:00:00Z'))).toEqual({
      branchId,
      on: '2026-03-03',
      loaned: 2,
      returned: 0,
      overdue: 0,
      holdsReady: 1,
    });
    expect(await circulationDaySummary(db.h.db, branchId, NOW)).toMatchObject({ on: '2026-03-15', loaned: 0, returned: 0, overdue: 1, holdsReady: 1 });
    expect(await circulationDaySummary(db.h.db, otherBranch, NOW)).toMatchObject({ loaned: 0, overdue: 0, holdsReady: 0 });
  });
});
