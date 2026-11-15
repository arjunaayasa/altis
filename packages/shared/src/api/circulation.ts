/**
 * The circulation API: the desk (find a member by number or name, the member panel, lend, return, renew one loan or all
 * of a member's loans), the loan list (a member's open loans and history, the overdue list) and the loan rules.
 *
 * - The desk works at a branch: its routes are `branches/:branchId/circulation/...` and need `circulation.desk.use` at
 *   that branch. A loan is made only at the item's own branch (`CIRC_OTHER_BRANCH {branchCode}`); a return and a renewal
 *   work at any branch (a return elsewhere warns `return_to_branch`).
 * - Every date of a loan (today, the due date, days late) is a calendar date `YYYY-MM-DD` in the time zone of the loan's
 *   branch (`branches.timezone`, else `library.timezone`). The due date is `loaned_on + loan_days`, cut to the member's
 *   `expires_on` when that comes first (`due_capped_by_expiry`), never before `loaned_on`. A due date that falls on a day
 *   the library calendar closes moves to the next open day (`due_moved_closed`); one cut at the expiry steps back to an
 *   open day. No open day within a year: 422 CIRC_CALENDAR_CLOSED.
 * - The loan rule is the most specific live rule for the member type, the item's collection type and the record's
 *   material type (the branch is always "all" in this edition); a tie goes to the rule whose first filled dimension
 *   comes earlier in that order. None: 422 CIRC_NO_POLICY. Its terms are copied into the loan; editing a rule never
 *   changes a running loan.
 * - An item on loan keeps its catalogue status (`available`): "on loan" is read from the open loan, not stored on the item.
 * - Personal data never travels in a URL: the member lookup and search are POST reads.
 * - The write routes are `store` routes: send an `Idempotency-Key` so a repeated scan answers the first response.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/circulation`.
 */
import { z } from 'zod';
import {
  CALENDAR_KINDS,
  CLEARANCE_PURPOSES,
  FORCEABLE_REASONS,
  LOAN_STATES,
  type CalendarKind,
  type CirculationWarning,
  type ClearancePurpose,
  type ClearanceRefusal,
  type OverrideReason,
  type PolicyRankReason,
  type VoidRefusal,
  type LimitScope,
  type LoanOutcome,
  type LoanState,
  type MemberStatus,
  type NotLoanableReason,
  type RenewRefusal,
} from '../circulation-vocab.js';
import { ulidField, versionField } from './common.js';
import { codeField, cursorQuery, dateField, priceField, shortText, type Paged } from './catalog/common.js';
import { rawBarcodeField } from './catalog/items.js';
import { rawMemberNoField, type MemberTypeRef } from './members.js';
// ---- Komunitas (holds) ----
import type { HoldView, ReturnHoldTrap } from './holds.js';
// ---- Komunitas (charges and payments) ----
import type { DeskChargesView, FinePreview } from './charges.js';

// ---- shared shapes ---------------------------------------------------------------------------------------------------

/** A warning of an action that succeeded; `branchCode` names the item's branch for `return_to_branch`. */
export interface CirculationWarningView {
  code: CirculationWarning;
  branchCode?: string;
  /** For `member_expires_soon`: the last valid day. */
  expiresOn?: string;
}

/** The item of a loan as the desk shows it (never the borrower on a public page). */
export interface LoanItemRef {
  id: string;
  barcode: string;
  /** The item's own call number, else its record's. */
  callNumber: string | null;
}

/** The record of a loan: its id and title. */
export interface LoanRecordRef {
  id: string;
  title: string;
}

/** The member of a loan, in the loan list (staff only). */
export interface LoanMemberRef {
  id: string;
  memberNo: string;
  name: string;
  className: string | null;
  typeId: string;
}

// ---- the desk: members -----------------------------------------------------------------------------------------------

/** `POST branches/:branchId/circulation/members/lookup` (a POST read) → `DeskMemberView`; 404 NOT_FOUND without a live member. */
export const DeskMemberLookupBody = z.strictObject({ no: rawMemberNoField });

export type DeskMemberLookupBody = z.infer<typeof DeskMemberLookupBody>;

/**
 * `POST branches/:branchId/circulation/members/search` (a POST read) → `DeskMemberSearchResponse`: at most 10 live
 * members whose number starts with, or whose name holds every word of, `q`; by name.
 */
export const DeskMemberSearchBody = z.strictObject({ q: shortText(191).min(1) });

export type DeskMemberSearchBody = z.infer<typeof DeskMemberSearchBody>;

/** One suggestion of the desk's member search. */
export interface DeskMemberSummary {
  id: string;
  memberNo: string;
  name: string;
  className: string | null;
  status: MemberStatus;
}

export interface DeskMemberSearchResponse {
  items: DeskMemberSummary[];
}

/** An open loan as the desk panel lists it (every branch's). */
export interface DeskLoanView {
  id: string;
  version: number;
  branchId: string;
  item: LoanItemRef;
  record: LoanRecordRef;
  loanedOn: string;
  dueOn: string;
  /** Days past `dueOn` today (0 when not overdue). */
  daysLate: number;
  renewals: number;
  renewLimit: number;
  /** The running fine if it came back today; null when it is not overdue or its rule has no fine. */
  finePreview: FinePreview | null;
}

/**
 * `GET branches/:branchId/circulation/members/:memberId` and the lookup: the desk panel. Only the fields the desk needs
 * (no address, no identity number). `canBorrow` is false with the first reason a loan would be refused for the member
 * alone (suspended, expired, a type that may not borrow, the type's limit reached); the item checks come with each loan.
 */
export interface DeskMemberView {
  id: string;
  memberNo: string;
  name: string;
  type: MemberTypeRef;
  className: string | null;
  status: MemberStatus;
  statusNote: string | null;
  expiresOn: string | null;
  photoFileId: string | null;
  notes: string | null;
  /** `holdsReady`: the member's holds whose copy is kept on a hold shelf now. */
  counts: { openLoans: number; overdue: number; holdsReady: number };
  canBorrow: boolean;
  /**
   * Why the member may not borrow now: an error code of this API (`MEMBER_SUSPENDED`, `MEMBER_EXPIRED`,
   * `CIRC_LIMIT_REACHED`, `CIRC_MEMBER_BLOCKED` with `charges.blocked`).
   */
  borrowRefusal: 'MEMBER_SUSPENDED' | 'MEMBER_EXPIRED' | 'CIRC_LIMIT_REACHED' | 'CIRC_MEMBER_BLOCKED' | null;
  /** The open loans, the oldest due date first. */
  loans: DeskLoanView[];
  /** The member's active holds (ready first, then waiting by the time they were placed), at every branch. */
  holds: HoldView[];
  warnings: CirculationWarningView[];
  /** The balance, the open charges, the last payments and the block that applies now. */
  charges: DeskChargesView;
}

// ---- the desk: lend, return, renew -------------------------------------------------------------------------------------

/**
 * `POST branches/:branchId/circulation/loans` → 201 `LoanResponse`. The checks, in order: the member is live (404),
 * not suspended (MEMBER_SUSPENDED), not expired (MEMBER_EXPIRED `{expiresOn}`); the barcode names a live item (404;
 * a valid ISBN-13 is `{path: 'barcode', code: 'isbn_not_barcode'}`; a barcode that is a member number answers 404 with
 * `meta.hint = 'member_no'`); the item is the desk branch's (CIRC_OTHER_BRANCH `{branchCode}`); its status is
 * `available` (CIRC_NOT_LOANABLE `{reason: 'status', status}`); it has no open loan (CIRC_ITEM_ON_LOAN `{sameMember}`);
 * its collection type may be lent (CIRC_NOT_LOANABLE `{reason: 'collection_type'}`); a rule applies (CIRC_NO_POLICY) and
 * allows it (CIRC_NOT_LOANABLE `{reason: 'policy'}`); the member is under the type's and the rule's limits
 * (CIRC_LIMIT_REACHED `{scope, limit}`).
 */
export const LoanBody = z.strictObject({
  memberId: ulidField,
  barcode: rawBarcodeField,
  /**
   * A loan entered after the fact (a power cut, a paper list): the day it was lent, in the branch's calendar, at most 30
   * days before today (`{path: 'loanedOn', code: 'backdate_out_of_range'}`). Needs `circulation.desk.override` at the
   * branch and an `override` with its `note`; the loan records `backdated`. The membership and blocks are still checked
   * for today; the due date counts from this day.
   */
  loanedOn: dateField.optional(),
  /**
   * Forces the checks named in `reasons` (FORCEABLE_REASONS) when they refuse; needs `circulation.desk.override` at the
   * branch and a `note`. Only the reasons that did refuse are recorded on the loan.
   */
  override: z
    .strictObject({
      reasons: z.array(z.enum(FORCEABLE_REASONS)).max(FORCEABLE_REASONS.length),
      note: shortText(191).min(1),
    })
    .optional(),
});

export type LoanBody = z.infer<typeof LoanBody>;

export interface LoanResponse {
  id: string;
  version: number;
  dueOn: string;
  item: LoanItemRef;
  record: LoanRecordRef;
  /** The member's own hold on the title that this loan fulfilled. */
  holdFulfilledId?: string;
  warnings?: CirculationWarningView[];
  /** The reasons recorded on the loan (forced checks, `backdated`). */
  overrides?: OverrideReason[];
}

/**
 * `POST branches/:branchId/circulation/returns` → `ReturnResponse`: the item's open loan is closed (`returned`), at any
 * branch. No open loan: 409 CIRC_LOAN_NOT_OPEN; an unknown barcode: 404.
 */
export const ReturnBody = z.strictObject({
  barcode: rawBarcodeField,
  /**
   * The item is recorded as lost (its last loan closed `lost`) and is back: it becomes `available` again and the unpaid
   * part of its lost charge is cancelled. Without it such an item answers 409 CIRC_LOAN_NOT_OPEN `{lostItem: true}`.
   */
  foundLost: z.literal(true).optional(),
});

export type ReturnBody = z.infer<typeof ReturnBody>;

export interface ReturnResponse {
  /** The closed loan. */
  id: string;
  version: number;
  memberId: string | null;
  memberNo: string | null;
  item: LoanItemRef;
  record: LoanRecordRef;
  loanedOn: string;
  dueOn: string;
  returnedOn: string;
  /** Calendar days past `dueOn` at the return (0 when on time). */
  daysLate: number;
  /**
   * The days late the overdue fine booked by this return counted: the open days only when the library's closed days are
   * not fined, so it may be less than `daysLate`. Absent when no fine was booked.
   */
  finedDays?: number;
  /** The copy is kept on the hold shelf for this member: put it there, with the slip. */
  hold?: ReturnHoldTrap;
  warnings?: CirculationWarningView[];
  /** The item was lost and came back (`foundLost`): no loan was open, `id` is its last (lost) loan. */
  foundLost?: boolean;
}

/**
 * `POST branches/:branchId/circulation/loans/:id/renew` (no body) → `RenewResponse`, at any branch. Refused with 409
 * CIRC_RENEW_REFUSED `{reason}` (RENEW_REFUSALS: `suspended`, `expired`, `same_day` (lent or renewed today), `limit`, or
 * `changed` when another desk renewed it first), CIRC_LOAN_NOT_OPEN when it is closed. An overdue loan may be renewed:
 * the new due date is counted from today.
 */
export interface RenewResponse {
  id: string;
  version: number;
  dueOn: string;
  renewals: number;
  renewLimit: number;
  warnings?: CirculationWarningView[];
}

/** One loan of a renew-all that was refused, with the reason (`not_open`: it was closed meanwhile). */
export interface RenewRefused {
  id: string;
  reason: RenewRefusal | 'not_open';
}

/**
 * `POST branches/:branchId/circulation/members/:memberId/renew-all` (no body) → `RenewAllResponse`: every open loan of the
 * member is renewed on its own, as the single renewal would (one audit entry per renewed loan); the others are listed
 * with their reason. Nothing renewed is still 200.
 */
export interface RenewAllResponse {
  renewed: { id: string; version: number; dueOn: string; renewals: number }[];
  refused: RenewRefused[];
}

// ---- the loan list (history, overdue) ----------------------------------------------------------------------------------

/**
 * `GET circulation/loans` → `LoanListResponse` (`circulation.records.read`). `state`: `open` (default), `closed`, or
 * `overdue` (open and past due today). `minDaysLate` applies to overdue loans. Open and overdue loans come by due date,
 * then id; closed ones by return time, newest first. No personal value is ever a parameter (a member is named by id).
 */
export const LoanListQuery = z.strictObject({
  state: z.enum(LOAN_STATES).default('open'),
  memberId: ulidField.optional(),
  itemId: ulidField.optional(),
  branchId: ulidField.optional(),
  memberTypeId: ulidField.optional(),
  minDaysLate: z.coerce.number().int().min(1).max(32_767).optional(),
  ...cursorQuery,
});

export type LoanListQuery = z.infer<typeof LoanListQuery>;

export interface LoanListItem {
  id: string;
  version: number;
  state: Exclude<LoanState, 'overdue'>;
  overdue: boolean;
  /** Days past due: today for an open loan, the return day for a closed one (0 when on time). */
  daysLate: number;
  branchId: string;
  loanedOn: string;
  dueOn: string;
  returnedOn: string | null;
  outcome: LoanOutcome | null;
  renewals: number;
  renewLimit: number;
  /** null when the item was removed (a migrated loan). */
  item: LoanItemRef | null;
  record: LoanRecordRef | null;
  /** null once the loan was anonymised. */
  member: LoanMemberRef | null;
  /** An overdue open loan's running fine if it came back today; null otherwise. */
  finePreview: FinePreview | null;
}

export type LoanListResponse = Paged<LoanListItem>;

// ---- loan rules ------------------------------------------------------------------------------------------------------

/** The longest loan, in days. */
export const LOAN_DAYS_MAX = 365;

/** A SMALLINT count of 0 or more. */
const smallCountField = z.int().min(0).max(32_767);

/**
 * `branchId` of a loan rule: only null (or absent) is accepted in this edition; anything else is the field error
 * `branch_scope_not_available`.
 */
const libraryWideBranchField = z
  .unknown()
  .check(
    z.check<unknown>((ctx) => {
      if (ctx.value !== null) {
        ctx.issues.push({ code: 'custom', params: { code: 'branch_scope_not_available' }, message: 'branch_scope_not_available', input: ctx.value });
      }
    }),
  )
  .transform((): null => null);

const policyFields = {
  code: codeField,
  name: shortText(191).min(1),
  /**
   * null: every member type. With the collection type and the material type it forms the rule's scope; another live
   * rule with the same three is `{path: 'scope', code: 'taken'}`.
   */
  memberTypeId: ulidField.nullable(),
  /** null: every collection type. */
  collectionTypeId: ulidField.nullable(),
  /** null: every material type. */
  materialTypeId: ulidField.nullable(),
  loanable: z.boolean(),
  loanDays: z.int().min(0).max(LOAN_DAYS_MAX),
  /** The most open loans a member may hold under this rule; null = no limit. */
  loanLimit: smallCountField.nullable(),
  renewLimit: smallCountField,
  /** The fine per day late, a decimal in the library's currency (`'500.00'`); 0 = no fine. */
  finePerDay: priceField,
  /** The most one loan's overdue fine can reach; null = no cap. */
  fineCap: priceField.nullable(),
  /** Days late that cost nothing; past them every late day counts. */
  graceDays: z.int().min(0).max(LOAN_DAYS_MAX),
};

/**
 * `POST circulation/policies` → 201 `StoreResponse`. The branch is always null in this edition; the currency is the
 * library's. A dimension that names no live member type, collection type or material type is `{path, code:
 * 'not_found'}`.
 */
export const PolicyBody = z.strictObject({
  ...policyFields,
  collectionTypeId: policyFields.collectionTypeId.default(null),
  materialTypeId: policyFields.materialTypeId.default(null),
  loanable: policyFields.loanable.default(true),
  renewLimit: policyFields.renewLimit.default(0),
  finePerDay: policyFields.finePerDay.default('0'),
  fineCap: policyFields.fineCap.default(null),
  graceDays: policyFields.graceDays.default(0),
  branchId: libraryWideBranchField.optional(),
});

export type PolicyBody = z.infer<typeof PolicyBody>;

/** `PATCH circulation/policies/:id` → `StoreResponse`. Running loans keep the terms they were made with. */
export const PolicyPatchBody = z.strictObject({ version: versionField, ...partialShape(policyFields) });

export type PolicyPatchBody = z.infer<typeof PolicyPatchBody>;

/** `GET circulation/policies`: live rules, the general one first, then by member type code; `includeArchived=true` adds the archived. */
export const PolicyListQuery = z.strictObject({ includeArchived: z.stringbool().optional() });

export type PolicyListQuery = z.infer<typeof PolicyListQuery>;

export interface PolicyView {
  id: string;
  code: string;
  name: string;
  /** null: every member type. */
  memberTypeId: string | null;
  /** null: every collection type. */
  collectionTypeId: string | null;
  /** null: every material type. */
  materialTypeId: string | null;
  /** Always null in this edition (every branch). */
  branchId: string | null;
  loanable: boolean;
  loanDays: number;
  loanLimit: number | null;
  renewLimit: number;
  /** Decimal strings in `currency`. */
  finePerDay: string;
  fineCap: string | null;
  graceDays: number;
  currency: string;
  /** How many dimensions the rule fills (0 for the general rule). */
  specificity: number;
  /** Open loans made under this rule (what its `loanLimit` counts). */
  openLoans: number;
  archived: boolean;
  version: number;
}

export interface PolicyListResponse {
  items: PolicyView[];
}

/**
 * `GET circulation/policies/resolve` → `PolicyResolveResponse`: the "which rule applies" tool. A dimension left out is
 * a loan without that value (a member type, collection type or material type that no rule names).
 */
export const PolicyResolveQuery = z.strictObject({
  memberTypeId: ulidField.optional(),
  collectionTypeId: ulidField.optional(),
  materialTypeId: ulidField.optional(),
});

export type PolicyResolveQuery = z.infer<typeof PolicyResolveQuery>;

/** One live rule that fits the combination, with its place in the ranking and why. */
export interface PolicyCandidateView {
  policy: PolicyView;
  rank: number;
  reason: PolicyRankReason;
}

export interface PolicyResolveResponse {
  /** The rule a loan with these dimensions gets; null: none fits (CIRC_NO_POLICY). */
  winner: PolicyView | null;
  /** Every fitting rule, the winner first. */
  candidates: PolicyCandidateView[];
}

// ---- the library calendar ----------------------------------------------------------------------------------------------

/** `MM-DD`, a day of the year (29 February allowed: it closes only in a leap year). */
const monthDayField = z.string().check(
  z.check<string>((ctx) => {
    const m = /^(\d{2})-(\d{2})$/.exec(ctx.value);
    const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const ok = m !== null && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= days[Number(m[1]) - 1]!;
    if (!ok) ctx.issues.push({ code: 'invalid_format', format: 'month_day', input: ctx.value });
  }),
);

/**
 * `POST circulation/calendar` → 201 `StoreResponse` (`circulation.policies.manage`): closed days of the library (every
 * branch; the branch is always null in this edition). By `kind`: `weekly` needs `weekday` (1 Monday … 7 Sunday; at most
 * six closed weekdays: `{path: 'weekday', code: 'too_many_closed'}`), `dates` needs `dateFrom` ≤ `dateTo` (`dateTo`
 * defaults to `dateFrom`; at most 366 days: `{path: 'dateTo', code: 'range_too_long'}`), `yearly` needs `monthDayFrom` ≤
 * `monthDayTo` within one year (`{path: 'monthDayTo', code: 'crosses_year'}`). The fields of the other kinds must be
 * absent or null.
 */
export const CalendarBody = z.strictObject({
  kind: z.enum(CALENDAR_KINDS),
  name: shortText(191).min(1),
  weekday: z.int().min(1).max(7).nullable().optional(),
  dateFrom: dateField.nullable().optional(),
  dateTo: dateField.nullable().optional(),
  monthDayFrom: monthDayField.nullable().optional(),
  monthDayTo: monthDayField.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
});

export type CalendarBody = z.infer<typeof CalendarBody>;

/** `PATCH circulation/calendar/:id` → `StoreResponse`: the fields sent replace the stored ones; the kind stays. */
export const CalendarPatchBody = z.strictObject({
  version: versionField,
  name: shortText(191).min(1).optional(),
  weekday: z.int().min(1).max(7).nullable().optional(),
  dateFrom: dateField.nullable().optional(),
  dateTo: dateField.nullable().optional(),
  monthDayFrom: monthDayField.nullable().optional(),
  monthDayTo: monthDayField.nullable().optional(),
});

export type CalendarPatchBody = z.infer<typeof CalendarPatchBody>;

/**
 * `GET circulation/calendar?from=&to=` → `CalendarResponse` (`circulation.desk.use` at any branch, or
 * `circulation.policies.manage`): the live closed-day rules, and with `from` (and `to`, default `from` + 41 days, at most
 * 400 days later) the closed dates in that span.
 */
export const CalendarQuery = z.strictObject({
  from: dateField.optional(),
  to: dateField.optional(),
});

export type CalendarQuery = z.infer<typeof CalendarQuery>;

export interface CalendarRuleView {
  id: string;
  kind: CalendarKind;
  name: string;
  weekday: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  monthDayFrom: string | null;
  monthDayTo: string | null;
  version: number;
}

export interface CalendarResponse {
  rules: CalendarRuleView[];
  /** The closed dates from `from` to `to` (both included), when `from` was given. */
  closed: string[];
}

// ---- the desk: void, lost, due date, read in place --------------------------------------------------------------------------

/**
 * `POST branches/:branchId/circulation/loans/:id/void` (no body) → `LoanVoidResponse`: the last loan is undone (outcome
 * `voided`, left out of every statistic) within `circulation.loanVoidMinutes` of the loan, when it was not renewed and
 * has no charge, by the staff member who lent it (another's needs `circulation.desk.override`). Else 409
 * CIRC_VOID_REFUSED `{reason}` (VOID_REFUSALS). Only a loan of the desk's branch (another branch's: 404).
 */
export interface LoanVoidResponse {
  id: string;
  version: number;
}

/**
 * `POST branches/:branchId/circulation/loans/:id/lost` → `LoanLostResponse`: the borrower declares the item lost. The
 * overdue fine up to today and the replacement charge are booked (by the charges module when it is installed); the loan
 * is closed `lost` and the item becomes `lost`. `replacement` (a decimal) is the charge; without it the item's price is
 * used when `circulation.lost.useItemPrice` and the item has one, else `{path: 'replacement', code: 'required'}`.
 */
export const LoanLostBody = z.strictObject({
  replacement: priceField.optional(),
  note: shortText(191).optional(),
});

export type LoanLostBody = z.infer<typeof LoanLostBody>;

export interface LoanLostResponse {
  id: string;
  version: number;
  /** The item's status now (`lost`, or its old status when that cannot become lost). */
  itemStatus: string;
  /** The replacement charge asked, a decimal in `currency`. */
  replacement: string;
  currency: string;
  /** Whether the charges module booked the charges (false: none is installed to book them). */
  charged: boolean;
}

/**
 * `PATCH branches/:branchId/circulation/loans/:id/due` → `LoanDueResponse` (`circulation.desk.override`): a new due date,
 * not before the day it was lent (`{path: 'dueOn', code: 'before_loan'}`). A closed day is allowed and warns
 * `due_on_closed_day`. The note is kept with the loan.
 */
export const LoanDueBody = z.strictObject({ dueOn: dateField, note: shortText(191).min(1) });

export type LoanDueBody = z.infer<typeof LoanDueBody>;

export interface LoanDueResponse {
  id: string;
  version: number;
  dueOn: string;
  warnings?: CirculationWarningView[];
}

/**
 * `POST branches/:branchId/circulation/in-library-uses` → 201 `InLibraryUseResponse`: one use of an item read in the
 * library, anonymous, counted at the desk's branch. An item on loan is counted and warns `item_on_loan`; one whose
 * status says it is not on the shelf (`missing`, `lost`) is counted and warns `item_status`. Not audited.
 */
export const InLibraryUseBody = z.strictObject({ barcode: rawBarcodeField });

export type InLibraryUseBody = z.infer<typeof InLibraryUseBody>;

export interface InLibraryUseResponse {
  id: string;
  item: LoanItemRef;
  record: LoanRecordRef;
  status: string;
  warnings?: CirculationWarningView[];
}

// ---- clearance letters ---------------------------------------------------------------------------------------------------

/** A list of member ids, 1 to 200, without repeats. */
const memberIdsField = z
  .array(ulidField)
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, { params: { code: 'duplicate' } });

/** The paper of a clearance letter: a sheet (A4, A5) or a receipt roll (58 or 80 mm). */
export const CLEARANCE_PAPERS = Object.freeze(['A4', 'A5', '58', '80'] as const);

export type ClearancePaper = (typeof CLEARANCE_PAPERS)[number];

/**
 * `POST members/clearances/check` (a POST read) → `ClearanceCheckResponse`: who may get a clearance letter now (no open
 * loan, no unpaid balance, no hold waiting on the hold shelf).
 */
export const ClearanceCheckBody = z.strictObject({ memberIds: memberIdsField });

export type ClearanceCheckBody = z.infer<typeof ClearanceCheckBody>;

export interface ClearanceCheckRow {
  memberId: string;
  memberNo: string;
  name: string;
  className: string | null;
  /** Empty: the member may get a letter. */
  refusals: ClearanceRefusal[];
}

export interface ClearanceCheckResponse {
  items: ClearanceCheckRow[];
}

/**
 * `POST members/clearances` → `application/pdf`: one numbered letter per member who passes the check, in the order
 * sent, then a page listing the members refused and why (`X-Altis-Clearance-Issued` and `X-Altis-Clearance-Refused`
 * count them). Numbers are `<prefix>/<year>/<4-digit sequence>`, the next ones of the library's year of `issuedOn`
 * (default today), with no gap and no repeat. A member that is not live is refused as not found.
 */
export const ClearanceIssueBody = z.strictObject({
  memberIds: memberIdsField,
  purpose: z.enum(CLEARANCE_PURPOSES),
  issuedOn: dateField.optional(),
  /** Default: the letter profile's paper. */
  paper: z.enum(CLEARANCE_PAPERS).optional(),
});

export type ClearanceIssueBody = z.infer<typeof ClearanceIssueBody>;

/** `GET members/clearances` → `Paged<ClearanceView>`: the letters, newest number first; filtered by member or year. */
export const ClearanceListQuery = z.strictObject({
  memberId: ulidField.optional(),
  year: z.coerce.number().int().min(1900).max(9999).optional(),
  ...cursorQuery,
});

export type ClearanceListQuery = z.infer<typeof ClearanceListQuery>;

export interface ClearanceView {
  id: string;
  memberId: string;
  memberNo: string | null;
  name: string | null;
  className: string | null;
  year: number;
  seq: number;
  number: string;
  issuedOn: string;
  purpose: ClearancePurpose;
  voided: boolean;
}

export type ClearanceListResponse = Paged<ClearanceView>;

/** `POST members/:id/clearances/:clearanceId/void` → `StoreResponse`-like `{id}`: the number is never used again. */
export const ClearanceVoidBody = z.strictObject({ reason: shortText(191).min(1) });

export type ClearanceVoidBody = z.infer<typeof ClearanceVoidBody>;

/** `GET members/:id/clearances/:clearanceId/pdf` → `application/pdf` of that letter again (same number). */
export const ClearancePdfQuery = z.strictObject({ paper: z.enum(CLEARANCE_PAPERS).optional() });

export type ClearancePdfQuery = z.infer<typeof ClearancePdfQuery>;

/** `meta` of CIRC_VOID_REFUSED. */
export interface VoidRefusedMeta {
  reason: VoidRefusal;
}

// ---- errors' meta ------------------------------------------------------------------------------------------------------

/** `meta` of CIRC_NOT_LOANABLE. */
export interface NotLoanableMeta {
  reason: NotLoanableReason;
  status?: string;
}

/** `meta` of CIRC_LIMIT_REACHED. */
export interface LimitReachedMeta {
  scope: LimitScope;
  limit: number;
}

/** `meta` of CIRC_RENEW_REFUSED. */
export interface RenewRefusedMeta {
  reason: RenewRefusal;
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

/** The fields of a create shape, each optional: a patch changes only what it sends (written out, so no default is inherited). */
function partialShape<S extends Record<string, z.ZodType>>(shape: S): { [K in keyof S]: z.ZodOptional<S[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = schema.optional();
  return out as { [K in keyof S]: z.ZodOptional<S[K]> };
}
