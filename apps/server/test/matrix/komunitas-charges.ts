import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch, seedOpenLoan } from './komunitas-circulation.js';
import { seedMember } from './komunitas-members.js';

// The matrix rows, fixtures and maintenance entries of charges and payments: the desk's charge, waive, payment, void and
// receipt routes, and the records' lists. One row per route id in db/matrix.test.ts's row format, one fixture per route
// in the same order. Every route is `deny` in maintenance and none is a `system` route. Each call gets rows of its own
// (a branch, a member, an open charge, a payment), so that a super admin's call succeeds (audit once).

const DESK = 'P:circulation.desk.use@branchId';
const WAIVE = 'P:circulation.charges.waive@branchId';
const RECORDS = 'P:circulation.records.read';
const DESK_API = '/api/v1/branches/:branchId/circulation';

const rows: Record<string, string> = {
  'circulation.desk.charges.create': `POST ${DESK_API}/members/:memberId/charges | ${DESK} | - | - | write | deny | store | circulation.charge.create | handler | -`,
  'circulation.desk.charges.waive': `POST ${DESK_API}/charges/:id/waive | ${WAIVE} | - | - | write | deny | store | circulation.charge.waive | handler | -`,
  'circulation.desk.payments.create': `POST ${DESK_API}/members/:memberId/payments | ${DESK} | - | - | write | deny | store | circulation.payment.create | handler | -`,
  'circulation.desk.payments.void': `POST ${DESK_API}/payments/:id/void | ${WAIVE} | - | - | write | deny | store | circulation.payment.void | handler | -`,
  'circulation.desk.payments.receipt': `GET ${DESK_API}/payments/:id/receipt | ${DESK} | - | - | read | deny | none | null | - | -`,
  'circulation.desk.slips': `POST ${DESK_API}/slips | ${DESK} | - | - | read | deny | none | null | self | -`,
  'circulation.charges.member': `GET /api/v1/circulation/members/:memberId/charges | ${RECORDS} | - | - | read | deny | none | null | - | -`,
  'circulation.charges.open': `GET /api/v1/circulation/charges/open | ${RECORDS} | - | - | read | deny | none | null | - | -`,
  'circulation.payments.summary': `GET /api/v1/circulation/payments/summary | ${RECORDS} | - | - | read | deny | none | null | - | -`,
  'circulation.payments.list': `GET /api/v1/circulation/payments | ${RECORDS} | - | - | read | deny | none | null | - | -`,
};

/** An open manual charge of 25 000.00 of `memberId` at `branchId`; its id. */
async function seedCharge(s: MatrixSeed, branchId: string, memberId: string): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('charges')
    .values({
      id,
      member_id: memberId,
      branch_id: branchId,
      loan_id: null,
      item_id: null,
      kind: 'manual',
      description: 'Biaya matriks',
      amount_minor: 2_500_000,
      paid_minor: 0,
      waived_minor: 0,
      currency: 'IDR',
      status: 'open',
      charged_on: '2026-10-26',
      charged_at: s.now,
      date_unknown: 0,
      source: 'desk',
      version: 0,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A branch of its own, a member and an open charge there. */
async function chargeAtBranch(s: MatrixSeed): Promise<{ branchId: string; memberId: string; chargeId: string }> {
  const branchId = await seedBranch(s);
  const memberId = (await seedMember(s)).id;
  return { branchId, memberId, chargeId: await seedCharge(s, branchId, memberId) };
}

/** A payment of 10 000.00 (receipt 2025/1 of a branch of its own) to an open charge; its branch and id. */
async function seedPayment(s: MatrixSeed): Promise<{ branchId: string; id: string }> {
  const c = await chargeAtBranch(s);
  const id = newId();
  await s.h.db
    .insertInto('payments')
    .values({
      id,
      member_id: c.memberId,
      branch_id: c.branchId,
      receipt_year: 2025,
      receipt_seq: 1,
      receipt_no: 'MC/2025/000001',
      amount_minor: 1_000_000,
      currency: 'IDR',
      method: 'cash',
      paid_on: '2025-10-27',
      paid_at: s.now,
      received_by: null,
      note: null,
      voided_at: null,
      voided_by: null,
      void_reason: null,
      date_unknown: 0,
      source: 'desk',
      version: 0,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  await s.h.db.insertInto('payment_allocations').values({ payment_id: id, charge_id: c.chargeId, amount_minor: 1_000_000 }).execute();
  await s.h.db.updateTable('charges').set({ paid_minor: 1_000_000 }).where('id', '=', c.chargeId).execute();
  return { branchId: c.branchId, id };
}

const fixtures: Record<string, MatrixFixture> = {
  'circulation.desk.charges.create': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, memberId: (await seedMember(s)).id }, body: { kind: 'card', amount: '5000', description: 'Kartu hilang' } };
  },
  'circulation.desk.charges.waive': async (s) => {
    const c = await chargeAtBranch(s);
    return { params: { branchId: c.branchId, id: c.chargeId }, body: { reason: 'Dihapuskan' } };
  },
  'circulation.desk.payments.create': async (s) => {
    const c = await chargeAtBranch(s);
    return { params: { branchId: c.branchId, memberId: c.memberId }, body: { amount: '25000', method: 'cash' } };
  },
  'circulation.desk.payments.void': async (s) => {
    const p = await seedPayment(s);
    return { params: { branchId: p.branchId, id: p.id }, body: { reason: 'Salah nominal' } };
  },
  'circulation.desk.payments.receipt': async (s) => {
    const p = await seedPayment(s);
    return { params: { branchId: p.branchId, id: p.id }, query: { paper: '80' } };
  },
  'circulation.desk.slips': async (s) => {
    const p = await seedPayment(s);
    return { params: { branchId: p.branchId }, body: { loanIds: [(await seedOpenLoan(s, p.branchId)).id], paymentIds: [p.id], paper: '58' } };
  },
  'circulation.charges.member': async (s) => ({ params: { memberId: (await chargeAtBranch(s)).memberId }, query: {} }),
  'circulation.charges.open': async () => ({ query: {} }),
  'circulation.payments.summary': async () => ({ query: { from: '2026-10-01', to: '2026-10-31' } }),
  'circulation.payments.list': async () => ({ query: {} }),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
