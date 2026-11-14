import {
  buildReceiptPdf,
  createCharge,
  ensureReceiptLockRow,
  listPayments,
  memberCharges,
  openBalances,
  paymentSummary,
  receiptData,
  receiptYearOf,
  takePayment,
  voidPayment,
  waiveCharge,
} from '@altis/core';
import {
  ChargeBody,
  ChargeWaiveBody,
  MemberChargesQuery,
  OpenBalancesQuery,
  PaymentBody,
  PaymentListQuery,
  PaymentSummaryQuery,
  PaymentVoidBody,
  ReceiptQuery,
  type ChargeView,
  type MemberChargesResponse,
  type OpenBalancesResponse,
  type PaymentListResponse,
  type PaymentSummaryResponse,
  type PaymentView,
} from '@altis/shared/api/charges';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Charges and payments.
//
// At the desk of a branch:
//   POST branches/:branchId/circulation/members/:memberId/charges   ChargeBody → 201 ChargeView        circulation.charge.create   (desk.use)
//   POST branches/:branchId/circulation/charges/:id/waive           ChargeWaiveBody → ChargeView       circulation.charge.waive    (charges.waive)
//   POST branches/:branchId/circulation/members/:memberId/payments  PaymentBody → 201 PaymentView      circulation.payment.create  (desk.use)
//   POST branches/:branchId/circulation/payments/:id/void           PaymentVoidBody → PaymentView      circulation.payment.void    (charges.waive)
//   GET  branches/:branchId/circulation/payments/:id/receipt        ReceiptQuery → application/pdf                                 (desk.use)
// Records (`circulation.records.read`, library-wide):
//   GET  circulation/members/:memberId/charges                      MemberChargesQuery → MemberChargesResponse
//   GET  circulation/charges/open                                   OpenBalancesQuery → OpenBalancesResponse
//   GET  circulation/payments                                       PaymentListQuery → PaymentListResponse
//   GET  circulation/payments/summary                               PaymentSummaryQuery → PaymentSummaryResponse (the daily cash summary)
//
// A charge or payment named by id must be the branch's (else 404); a payment goes only to the member's open charges at
// the branch. Taking a payment numbers its receipt: the route works out the branch's year and makes sure the year's lock
// row exists before its transaction (`prepare`), and the transaction takes that lock first. The receipt is in the
// library's language on a 58 or 80 mm roll.

const API = '/api/v1/branches/:branchId/circulation';
const MemberParams = z.strictObject({ branchId: ulidField, memberId: ulidField });
const IdParams = z.strictObject({ branchId: ulidField, id: ulidField });

const chargesCreate = route({
  id: 'circulation.desk.charges.create',
  method: 'POST',
  path: `${API}/members/:memberId/charges`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.charge.create',
  params: MemberParams,
  body: ChargeBody,
  handler: async (rc) => {
    const b = rc.body;
    const body: ChargeView = await createCharge(rc.tx(), {
      branchId: rc.params.branchId,
      memberId: rc.params.memberId,
      kind: b.kind,
      amount: b.amount,
      description: b.description,
      ...(b.barcode === undefined ? {} : { barcode: b.barcode }),
    });
    return { status: 201, body };
  },
});

const chargesWaive = route({
  id: 'circulation.desk.charges.waive',
  method: 'POST',
  path: `${API}/charges/:id/waive`,
  permission: 'circulation.charges.waive',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.charge.waive',
  params: IdParams,
  body: ChargeWaiveBody,
  handler: async (rc) => {
    const b = rc.body;
    const body: ChargeView = await waiveCharge(rc.tx(), {
      branchId: rc.params.branchId,
      chargeId: rc.params.id,
      reason: b.reason,
      ...(b.amount === undefined ? {} : { amount: b.amount }),
    });
    return { body };
  },
});

const paymentsCreate = route({
  id: 'circulation.desk.payments.create',
  method: 'POST',
  path: `${API}/members/:memberId/payments`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.payment.create',
  params: MemberParams,
  body: PaymentBody,
  prepare: async (rc) => {
    const at = await receiptYearOf(rc.db.db, rc.params.branchId, rc.now);
    await ensureReceiptLockRow(rc.db, rc.params.branchId, at.year);
    return at;
  },
  handler: async (rc) => {
    const b = rc.body;
    const at = rc.prepared as { timeZone: string; year: number };
    const body: PaymentView = await takePayment(rc.tx(), {
      branchId: rc.params.branchId,
      memberId: rc.params.memberId,
      amount: b.amount,
      method: b.method,
      timeZone: at.timeZone,
      year: at.year,
      ...(b.chargeIds === undefined ? {} : { chargeIds: b.chargeIds }),
      ...(b.note === undefined ? {} : { note: b.note }),
    });
    return { status: 201, body };
  },
});

const paymentsVoid = route({
  id: 'circulation.desk.payments.void',
  method: 'POST',
  path: `${API}/payments/:id/void`,
  permission: 'circulation.charges.waive',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.payment.void',
  params: IdParams,
  body: PaymentVoidBody,
  handler: async (rc) => {
    const body: PaymentView = await voidPayment(rc.tx(), { branchId: rc.params.branchId, paymentId: rc.params.id, reason: rc.body.reason });
    return { body };
  },
});

const paymentsReceipt = route({
  id: 'circulation.desk.payments.receipt',
  method: 'GET',
  path: `${API}/payments/:id/receipt`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  query: ReceiptQuery,
  handler: async (rc) => {
    const data = await receiptData(rc.db.db, { branchId: rc.params.branchId, paymentId: rc.params.id, ...(rc.query.paper === undefined ? {} : { paper: rc.query.paper }) });
    const pdf = buildReceiptPdf(data);
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="kuitansi.pdf"',
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  },
});

const memberChargesList = route({
  id: 'circulation.charges.member',
  method: 'GET',
  path: '/api/v1/circulation/members/:memberId/charges',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  params: z.strictObject({ memberId: ulidField }),
  query: MemberChargesQuery,
  handler: async (rc) => {
    const body: MemberChargesResponse = await memberCharges(rc.db.db, rc.params.memberId, rc.query);
    return { body };
  },
});

const openBalancesList = route({
  id: 'circulation.charges.open',
  method: 'GET',
  path: '/api/v1/circulation/charges/open',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: OpenBalancesQuery,
  handler: async (rc) => {
    const body: OpenBalancesResponse = await openBalances(rc.db.db, rc.query);
    return { body };
  },
});

const paymentsList = route({
  id: 'circulation.payments.list',
  method: 'GET',
  path: '/api/v1/circulation/payments',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: PaymentListQuery,
  handler: async (rc) => {
    const body: PaymentListResponse = await listPayments(rc.db.db, rc.query);
    return { body };
  },
});

const paymentsSummary = route({
  id: 'circulation.payments.summary',
  method: 'GET',
  path: '/api/v1/circulation/payments/summary',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: PaymentSummaryQuery,
  handler: async (rc) => {
    const body: PaymentSummaryResponse = await paymentSummary(rc.db.db, rc.query, rc.now);
    return { body };
  },
});

export const CHARGE_ROUTES: RouteDecl[] = [
  chargesCreate,
  chargesWaive,
  paymentsCreate,
  paymentsVoid,
  paymentsReceipt,
  memberChargesList,
  openBalancesList,
  paymentsSummary,
  paymentsList,
];
