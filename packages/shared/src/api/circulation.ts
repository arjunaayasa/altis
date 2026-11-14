/**
 * The circulation API: the desk (find a member by number or name, the member panel, lend, return, renew one loan or all
 * of a member's loans), the loan list (a member's open loans and history, the overdue list) and the loan rules.
 *
 * - The desk works at a branch: its routes are `branches/:branchId/circulation/...` and need `circulation.desk.use` at
 *   that branch. A loan is made only at the item's own branch (`CIRC_OTHER_BRANCH {branchCode}`); a return and a renewal
 *   work at any branch (a return elsewhere warns `return_to_branch`).
 * - Every date of a loan (today, the due date, days late) is a calendar date `YYYY-MM-DD` in the time zone of the loan's
 *   branch (`branches.timezone`, else `library.timezone`). The due date is `loaned_on + loan_days`, cut to the member's
 *   `expires_on` when that comes first (`due_capped_by_expiry`), never before `loaned_on`. Closed days are not counted in
 *   this milestone.
 * - The loan rule is the most specific live rule for the member's type, else the general rule (every dimension "all");
 *   none: 422 CIRC_NO_POLICY. Its terms are copied into the loan; editing a rule never changes a running loan.
 * - An item on loan keeps its catalogue status (`available`): "on loan" is read from the open loan, not stored on the item.
 * - Personal data never travels in a URL: the member lookup and search are POST reads.
 * - The write routes are `store` routes: send an `Idempotency-Key` so a repeated scan answers the first response.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/circulation`.
 */
import { z } from 'zod';
import {
  LOAN_STATES,
  type CirculationWarning,
  type LimitScope,
  type LoanOutcome,
  type LoanState,
  type MemberStatus,
  type NotLoanableReason,
  type RenewRefusal,
} from '../circulation-vocab.js';
import { ulidField, versionField } from './common.js';
import { codeField, cursorQuery, shortText, type Paged } from './catalog/common.js';
import { rawBarcodeField } from './catalog/items.js';
import { rawMemberNoField, type MemberTypeRef } from './members.js';

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
  counts: { openLoans: number; overdue: number };
  canBorrow: boolean;
  /** Why the member may not borrow now: an error code of this API (`MEMBER_SUSPENDED`, `MEMBER_EXPIRED`, `CIRC_LIMIT_REACHED`). */
  borrowRefusal: 'MEMBER_SUSPENDED' | 'MEMBER_EXPIRED' | 'CIRC_LIMIT_REACHED' | null;
  /** The open loans, the oldest due date first. */
  loans: DeskLoanView[];
  warnings: CirculationWarningView[];
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
export const LoanBody = z.strictObject({ memberId: ulidField, barcode: rawBarcodeField });

export type LoanBody = z.infer<typeof LoanBody>;

export interface LoanResponse {
  id: string;
  version: number;
  dueOn: string;
  item: LoanItemRef;
  record: LoanRecordRef;
  warnings?: CirculationWarningView[];
}

/**
 * `POST branches/:branchId/circulation/returns` → `ReturnResponse`: the item's open loan is closed (`returned`), at any
 * branch. No open loan: 409 CIRC_LOAN_NOT_OPEN; an unknown barcode: 404.
 */
export const ReturnBody = z.strictObject({ barcode: rawBarcodeField });

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
  daysLate: number;
  warnings?: CirculationWarningView[];
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
  /** null: every member type. Another live rule for the same type is `{path: 'memberTypeId', code: 'taken'}`. */
  memberTypeId: ulidField.nullable(),
  loanable: z.boolean(),
  loanDays: z.int().min(0).max(LOAN_DAYS_MAX),
  /** The most open loans a member may hold under this rule; null = no limit. */
  loanLimit: smallCountField.nullable(),
  renewLimit: smallCountField,
};

/**
 * `POST circulation/policies` → 201 `StoreResponse`. This milestone uses the member-type dimension only: collection type
 * and material type stay "all", the branch is always null, there are no fines (0) and the currency is the library's.
 */
export const PolicyBody = z.strictObject({
  ...policyFields,
  loanable: policyFields.loanable.default(true),
  renewLimit: policyFields.renewLimit.default(0),
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
  /** Always null in this milestone (every collection type). */
  collectionTypeId: string | null;
  /** Always null in this milestone (every material type). */
  materialTypeId: string | null;
  /** Always null in this edition (every branch). */
  branchId: string | null;
  loanable: boolean;
  loanDays: number;
  loanLimit: number | null;
  renewLimit: number;
  currency: string;
  /** Open loans made under this rule (what its `loanLimit` counts). */
  openLoans: number;
  archived: boolean;
  version: number;
}

export interface PolicyListResponse {
  items: PolicyView[];
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
