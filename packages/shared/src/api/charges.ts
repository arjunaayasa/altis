/**
 * The charges and payments API: what a member owes (overdue fines, lost items, damage, a member card, other charges),
 * waiving it, taking a payment with a numbered receipt, voiding a payment, the receipt PDF, and the lists staff read
 * (a member's charges and payments, the open balances, the payments and their daily summary).
 *
 * - Money travels as a decimal string (`"12500.00"`) in `currency` (the library's, `catalog.currency`); the database
 *   keeps minor units. A charge's `balance` is `amount − paid − waived`; a member's balance is the sum over the open
 *   charges.
 * - The system books overdue fines when a late loan is returned, renewed late, or declared lost: the rule's fine per
 *   day times every day late (the library's closed days left out when `circulation.fines.skipClosedDays`), nothing
 *   within the grace days, at most the rule's cap. A loan declared lost also books the replacement and, when the
 *   library charges one, the processing fee; a lost item that comes back cancels what is left of its replacement.
 * - A payment goes to the charges chosen (`chargeIds`, else every open charge of the desk's branch, oldest first) and
 *   may not be more than what they leave (`{path: 'amount', code: 'exceeds_balance'}`). Its receipt number is
 *   `<branch code>/<year>/<sequence, 6 digits>`, the next of the branch and the library's year, never reused (a voided
 *   payment keeps its number).
 * - A charge or payment named by id at a branch must be that branch's (else 404, as if it did not exist).
 * - Personal data never travels in a URL: a member is named by id.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/charges`.
 */
import { z } from 'zod';
import {
  MANUAL_CHARGE_KINDS,
  PAYMENT_METHODS,
  type ChargeAdjustmentKind,
  type ChargeKind,
  type ChargeSource,
  type ChargeStatus,
  type MemberBlockReason,
  type PaymentMethod,
} from '../circulation-vocab.js';
import { cursorQuery, dateField, priceField, shortText, type Paged } from './catalog/common.js';
import { rawBarcodeField } from './catalog/items.js';
import { ulidField } from './common.js';

// ---- views -----------------------------------------------------------------------------------------------------------

/** The item a charge is about, when it names one. */
export interface ChargeItemRef {
  id: string;
  barcode: string;
  title: string | null;
}

/** A charge as staff see it. */
export interface ChargeView {
  id: string;
  version: number;
  memberId: string;
  branchId: string;
  loanId: string | null;
  kind: ChargeKind;
  description: string;
  amount: string;
  paid: string;
  /** Waived or cancelled. */
  waived: string;
  /** What is left to pay. */
  balance: string;
  currency: string;
  status: ChargeStatus;
  chargedOn: string;
  /** A migrated charge whose day was not known (`chargedOn` is the day it was migrated). */
  dateUnknown: boolean;
  source: ChargeSource;
  item: ChargeItemRef | null;
}

/** A waive or a cancellation of a charge. */
export interface ChargeAdjustmentView {
  id: string;
  chargeId: string;
  kind: ChargeAdjustmentKind;
  amount: string;
  reason: string;
  at: number;
  /** The staff member's name; null for the system. */
  by: string | null;
}

/** The part of a payment that went to one charge. */
export interface PaymentAllocationView {
  chargeId: string;
  amount: string;
  kind: ChargeKind;
  description: string;
}

/** A payment as staff see it. */
export interface PaymentView {
  id: string;
  version: number;
  memberId: string;
  branchId: string;
  /** `<branch code>/<yyyy>/<seq, 6 digits>`; null for a migrated payment. */
  receiptNo: string | null;
  amount: string;
  currency: string;
  method: PaymentMethod;
  paidOn: string;
  paidAt: number;
  /** The staff member who took it (name); null when unknown. */
  receivedBy: string | null;
  note: string | null;
  voided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  allocations: PaymentAllocationView[];
}

/**
 * What the desk panel shows of a member's money (part of `DeskMemberView`): the balance, the open charges (oldest
 * first), the last 10 payments, and the block that would refuse a loan now (null when none applies).
 */
export interface DeskChargesView {
  balance: string;
  currency: string;
  charges: ChargeView[];
  payments: PaymentView[];
  blocked: MemberBlockReason | null;
}

/** The running fine of an overdue open loan if it came back today (nothing is booked until it does). */
export interface FinePreview {
  amount: string;
  currency: string;
  /** The days counted (closed days left out when the library says so). */
  days: number;
}

// ---- the desk: charges -----------------------------------------------------------------------------------------------

/**
 * `POST branches/:branchId/circulation/members/:memberId/charges` → 201 `ChargeView` (`circulation.desk.use`): a charge
 * booked by hand (damage, a member card, anything else), more than 0, with a description; `barcode` links it to an item
 * (404 when there is no such live item). The member must be live (404).
 */
export const ChargeBody = z.strictObject({
  kind: z.enum(MANUAL_CHARGE_KINDS),
  amount: priceField,
  description: shortText(191).min(1),
  barcode: rawBarcodeField.optional(),
});

export type ChargeBody = z.infer<typeof ChargeBody>;

/**
 * `POST branches/:branchId/circulation/charges/:id/waive` → `ChargeView` (`circulation.charges.waive`): waives `amount`
 * of what is left (all of it without `amount`; more than is left is `{path: 'amount', code: 'exceeds_balance'}`), with a
 * reason. A charge that is not open: 409 CIRC_CHARGE_STATE `{status}`.
 */
export const ChargeWaiveBody = z.strictObject({
  amount: priceField.optional(),
  reason: shortText(191).min(1),
});

export type ChargeWaiveBody = z.infer<typeof ChargeWaiveBody>;

// ---- the desk: payments ----------------------------------------------------------------------------------------------

/** A list of charge ids, 1 to 100, without repeats. */
const chargeIdsField = z
  .array(ulidField)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { params: { code: 'duplicate' } });

/**
 * `POST branches/:branchId/circulation/members/:memberId/payments` → 201 `PaymentView` (`circulation.desk.use`): a
 * payment of `amount` (more than 0) to the charges `chargeIds` (each an open charge of the member at the desk's branch,
 * else 404), or without them to every open charge of the member at the desk's branch, oldest first. More than they
 * leave: `{path: 'amount', code: 'exceeds_balance'}`. Send an `Idempotency-Key`: a repeated request answers the first
 * payment.
 */
export const PaymentBody = z.strictObject({
  amount: priceField,
  method: z.enum(PAYMENT_METHODS),
  chargeIds: chargeIdsField.optional(),
  note: shortText(191).optional(),
});

export type PaymentBody = z.infer<typeof PaymentBody>;

/**
 * `POST branches/:branchId/circulation/payments/:id/void` → `PaymentView` (`circulation.charges.waive`): the payment is
 * voided with a reason, what it paid is owed again, its receipt number is never used again. Voided already: 409
 * CIRC_CHARGE_STATE `{status: 'voided'}`.
 */
export const PaymentVoidBody = z.strictObject({ reason: shortText(191).min(1) });

export type PaymentVoidBody = z.infer<typeof PaymentVoidBody>;

/** The receipt roll widths, in millimetres. */
export const RECEIPT_PAPERS = Object.freeze(['58', '80'] as const);

export type ReceiptPaper = (typeof RECEIPT_PAPERS)[number];

/**
 * `GET branches/:branchId/circulation/payments/:id/receipt` → `application/pdf` (`circulation.desk.use`): the receipt on
 * a 58 or 80 mm roll (default `circulation.receipt.paperMm`), in the library's language; a voided payment's receipt
 * says it is void.
 */
export const ReceiptQuery = z.strictObject({ paper: z.enum(RECEIPT_PAPERS).optional() });

export type ReceiptQuery = z.infer<typeof ReceiptQuery>;

/** A list of ids, 0 to `max`, without repeats. */
const idsField = (max: number) =>
  z
    .array(ulidField)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { params: { code: 'duplicate' } });

/**
 * `POST branches/:branchId/circulation/slips` → `application/pdf` (`circulation.desk.use`, a POST read): the transaction
 * slip of a visit on a 58 or 80 mm roll: the loans and renewals (`loanIds`, made or returned at this branch), the items
 * returned (`returnedLoanIds`, with days late and the fine booked) and the payments taken here (`paymentIds`). At least
 * one id; any of another branch is 404.
 */
export const SlipBody = z
  .strictObject({
    loanIds: idsField(50).default([]),
    returnedLoanIds: idsField(50).default([]),
    paymentIds: idsField(10).default([]),
    paper: z.enum(RECEIPT_PAPERS).optional(),
  })
  .refine((b) => b.loanIds.length + b.returnedLoanIds.length + b.paymentIds.length > 0, { params: { code: 'required' }, path: ['loanIds'] });

export type SlipBody = z.infer<typeof SlipBody>;

// ---- records (`circulation.records.read`) ----------------------------------------------------------------------------

/** `GET circulation/members/:memberId/charges` → `MemberChargesResponse`: every charge and payment of the member, newest first. */
export const MemberChargesQuery = z.strictObject({ status: z.enum(['open', 'all']).default('all') });

export type MemberChargesQuery = z.infer<typeof MemberChargesQuery>;

export interface MemberChargesResponse {
  memberId: string;
  balance: string;
  currency: string;
  /** At most 500, newest first. */
  charges: ChargeView[];
  adjustments: ChargeAdjustmentView[];
  /** At most 200, newest first. */
  payments: PaymentView[];
}

/** The member of a balance or a payment in a list. */
export interface ChargeMemberRef {
  id: string;
  memberNo: string;
  name: string;
  className: string | null;
}

/** `GET circulation/charges/open?branchId=` → `OpenBalancesResponse`: the members with an unpaid balance, the largest first. */
export const OpenBalancesQuery = z.strictObject({ branchId: ulidField.optional() });

export type OpenBalancesQuery = z.infer<typeof OpenBalancesQuery>;

export interface OpenBalanceItem {
  member: ChargeMemberRef;
  balance: string;
  openCharges: number;
  oldestChargedOn: string;
}

export interface OpenBalancesResponse {
  currency: string;
  /** At most 500 members. */
  items: OpenBalanceItem[];
  /** The sum over every member listed. */
  total: string;
  truncated: boolean;
}

/**
 * `GET circulation/payments` → `PaymentListResponse`: payments by the day they were taken (`from`…`to`, both
 * included), newest first; voided ones included and marked.
 */
export const PaymentListQuery = z.strictObject({
  branchId: ulidField.optional(),
  memberId: ulidField.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: dateField.optional(),
  to: dateField.optional(),
  ...cursorQuery,
});

export type PaymentListQuery = z.infer<typeof PaymentListQuery>;

export interface PaymentListItem extends PaymentView {
  member: ChargeMemberRef | null;
}

export type PaymentListResponse = Paged<PaymentListItem>;

/**
 * `GET circulation/payments/summary` → `PaymentSummaryResponse`: the cash summary of the days `from`…`to` (both
 * included, at most 366 days; default today): per day and in all, the sum and count per method and per staff member,
 * voided payments left out of the sums and counted apart.
 */
export const PaymentSummaryQuery = z.strictObject({
  branchId: ulidField.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});

export type PaymentSummaryQuery = z.infer<typeof PaymentSummaryQuery>;

/** Sums of a group of payments. */
export interface PaymentTotals {
  count: number;
  total: string;
  byMethod: Record<PaymentMethod, string>;
}

export interface PaymentSummaryDay extends PaymentTotals {
  day: string;
  byStaff: (PaymentTotals & { staffId: string | null; name: string | null })[];
}

export interface PaymentSummaryResponse {
  from: string;
  to: string;
  currency: string;
  days: PaymentSummaryDay[];
  all: PaymentTotals;
  byStaff: (PaymentTotals & { staffId: string | null; name: string | null })[];
  voided: { count: number; total: string };
}

// ---- errors' meta ----------------------------------------------------------------------------------------------------

/** `meta` of CIRC_MEMBER_BLOCKED. */
export interface MemberBlockedMeta {
  reason: MemberBlockReason;
}
