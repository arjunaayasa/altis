import {
  can,
  changeLoanDue,
  deskItemGlance,
  deskMemberLookup,
  deskMemberSearch,
  deskMemberView,
  lendItem,
  markLoanLost,
  recordInLibraryUse,
  renewAllLoans,
  renewLoan,
  returnItem,
  voidLoan,
} from '@altis/core';
import {
  DeskItemGlanceBody,
  DeskMemberLookupBody,
  DeskMemberSearchBody,
  InLibraryUseBody,
  LoanBody,
  LoanDueBody,
  LoanLostBody,
  ReturnBody,
  type DeskItemGlance,
  type DeskMemberSearchResponse,
  type DeskMemberView,
  type InLibraryUseResponse,
  type LoanDueResponse,
  type LoanLostResponse,
  type LoanResponse,
  type LoanVoidResponse,
  type RenewAllResponse,
  type RenewResponse,
  type ReturnResponse,
} from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';

// The circulation desk, at a branch (`circulation.desk.use` at `:branchId`):
//
//   POST branches/:branchId/circulation/members/lookup               DeskMemberLookupBody → DeskMemberView     read, tx self
//   POST branches/:branchId/circulation/members/search               DeskMemberSearchBody → DeskMemberSearchResponse  read, tx self
//   GET  branches/:branchId/circulation/members/:memberId            → DeskMemberView
//   POST branches/:branchId/circulation/members/:memberId/renew-all  (no body) → RenewAllResponse  also circulation.loan.renew
//   POST branches/:branchId/circulation/loans                        LoanBody → 201 LoanResponse    circulation.loan.create
//   POST branches/:branchId/circulation/returns                      ReturnBody → ReturnResponse    circulation.loan.return
//   POST branches/:branchId/circulation/loans/:id/renew              (no body) → RenewResponse      circulation.loan.renew
//   POST branches/:branchId/circulation/loans/:id/void               (no body) → LoanVoidResponse   circulation.loan.void
//   POST branches/:branchId/circulation/loans/:id/lost               LoanLostBody → LoanLostResponse circulation.loan.lost
//   PATCH branches/:branchId/circulation/loans/:id/due               LoanDueBody → LoanDueResponse  circulation.loan.due_change
//   POST branches/:branchId/circulation/in-library-uses              InLibraryUseBody → 201 InLibraryUseResponse  (not audited)
//
// `circulation.desk.override` at the branch: forcing a loan (`override`) and a loan dated before today (`loanedOn`) are
// refused without it before anything is written (403); changing a due date needs it as the route's own permission;
// voiding a loan another staff member made is CIRC_VOID_REFUSED `other_staff` without it. Void, lost and the due date
// act only on a loan of the desk's branch (another branch's answers 404).
//
// Lend: only an item of the desk's branch. Return and renew: at any branch (the loan's own branch decides its dates).
// Every write locks before it reads: the item by its barcode (or the loan by its id, then its item), then the record,
// then the member, each as the transaction's first statements; `loans.open_item_id` (unique) is the final guarantee of
// one open loan per item. Renew-all renews each open loan of the member as the single renewal does and audits each
// renewed loan once, so it declares no audit action of its own.

const API = '/api/v1/branches/:branchId/circulation';
const BranchParams = z.strictObject({ branchId: ulidField });
const MemberParams = z.strictObject({ branchId: ulidField, memberId: ulidField });
const LoanParams = z.strictObject({ branchId: ulidField, id: ulidField });

const membersLookup = route({
  id: 'circulation.desk.members.lookup',
  method: 'POST',
  path: `${API}/members/lookup`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: BranchParams,
  body: DeskMemberLookupBody,
  handler: async (rc) => {
    const body: DeskMemberView = await deskMemberLookup(rc.db.db, { branchId: rc.params.branchId, no: rc.body.no }, rc.now);
    return { body };
  },
});

const membersSearch = route({
  id: 'circulation.desk.members.search',
  method: 'POST',
  path: `${API}/members/search`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: BranchParams,
  body: DeskMemberSearchBody,
  handler: async (rc) => {
    const body: DeskMemberSearchResponse = await deskMemberSearch(rc.db.db, { branchId: rc.params.branchId, q: rc.body.q }, rc.now);
    return { body };
  },
});

const memberPanel = route({
  id: 'circulation.desk.members.get',
  method: 'GET',
  path: `${API}/members/:memberId`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'none',
  audit: null,
  params: MemberParams,
  handler: async (rc) => {
    const body: DeskMemberView = await deskMemberView(rc.db.db, { branchId: rc.params.branchId, memberId: rc.params.memberId }, rc.now);
    return { body };
  },
});

const renewAll = route({
  id: 'circulation.desk.members.renew_all',
  method: 'POST',
  path: `${API}/members/:memberId/renew-all`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: null,
  alsoAudits: ['circulation.loan.renew'],
  params: MemberParams,
  handler: async (rc) => {
    const body: RenewAllResponse = await renewAllLoans(rc.tx(), { branchId: rc.params.branchId, memberId: rc.params.memberId });
    return { body };
  },
});

/** Whether the request's user holds `circulation.desk.override` at the branch `branchId`. */
function mayOverride(rc: RouteContext<unknown, unknown, unknown>, branchId: string): boolean {
  const grants = rc.auth?.grants;
  return grants !== undefined && can(grants, 'circulation.desk.override', branchId);
}

const loansCreate = route({
  id: 'circulation.desk.loans.create',
  method: 'POST',
  path: `${API}/loans`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.create',
  params: BranchParams,
  body: LoanBody,
  prepare: async (rc) => {
    if ((rc.body.override !== undefined || rc.body.loanedOn !== undefined) && !mayOverride(rc, rc.params.branchId)) {
      throw await rc.authzDenied('circulation.desk.override');
    }
  },
  handler: async (rc) => {
    const b = rc.body;
    const body: LoanResponse = await lendItem(rc.tx(), {
      branchId: rc.params.branchId,
      memberId: b.memberId,
      barcode: b.barcode,
      ...(b.loanedOn === undefined ? {} : { loanedOn: b.loanedOn }),
      ...(b.override === undefined ? {} : { override: b.override }),
    });
    return { status: 201, body };
  },
});

const returnsCreate = route({
  id: 'circulation.desk.returns.create',
  method: 'POST',
  path: `${API}/returns`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.return',
  params: BranchParams,
  body: ReturnBody,
  handler: async (rc) => {
    const body: ReturnResponse = await returnItem(rc.tx(), { branchId: rc.params.branchId, barcode: rc.body.barcode, foundLost: rc.body.foundLost === true });
    return { body };
  },
});

const loansRenew = route({
  id: 'circulation.desk.loans.renew',
  method: 'POST',
  path: `${API}/loans/:id/renew`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.renew',
  params: LoanParams,
  handler: async (rc) => {
    const body: RenewResponse = await renewLoan(rc.tx(), { branchId: rc.params.branchId, loanId: rc.params.id });
    return { body };
  },
});

// ---- Komunitas (circulation core) ----

const loansVoid = route({
  id: 'circulation.desk.loans.void',
  method: 'POST',
  path: `${API}/loans/:id/void`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.void',
  params: LoanParams,
  prepare: async (rc) => mayOverride(rc, rc.params.branchId),
  handler: async (rc) => {
    const body: LoanVoidResponse = await voidLoan(rc.tx(), { branchId: rc.params.branchId, loanId: rc.params.id, mayOverride: rc.prepared === true });
    return { body };
  },
});

const loansLost = route({
  id: 'circulation.desk.loans.lost',
  method: 'POST',
  path: `${API}/loans/:id/lost`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.lost',
  params: LoanParams,
  body: LoanLostBody,
  handler: async (rc) => {
    const b = rc.body;
    const body: LoanLostResponse = await markLoanLost(rc.tx(), {
      branchId: rc.params.branchId,
      loanId: rc.params.id,
      ...(b.replacement === undefined ? {} : { replacement: b.replacement }),
      ...(b.note === undefined ? {} : { note: b.note }),
    });
    return { body };
  },
});

const loansDue = route({
  id: 'circulation.desk.loans.due',
  method: 'PATCH',
  path: `${API}/loans/:id/due`,
  permission: 'circulation.desk.override',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: 'circulation.loan.due_change',
  params: LoanParams,
  body: LoanDueBody,
  handler: async (rc) => {
    const body: LoanDueResponse = await changeLoanDue(rc.tx(), { branchId: rc.params.branchId, loanId: rc.params.id, dueOn: rc.body.dueOn, note: rc.body.note });
    return { body };
  },
});

const inLibraryUses = route({
  id: 'circulation.desk.in_library_uses.create',
  method: 'POST',
  path: `${API}/in-library-uses`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  idempotency: 'store',
  audit: null,
  params: BranchParams,
  body: InLibraryUseBody,
  handler: async (rc) => {
    const body: InLibraryUseResponse = await recordInLibraryUse(rc.tx(), { branchId: rc.params.branchId, barcode: rc.body.barcode });
    return { status: 201, body };
  },
});

// ---- Komunitas (staff screens' data) ----
// What the desk may say about a scanned item under a refusal (title, status, branch, due date, kept on the hold shelf),
// never the member who holds it: a POST read, since a scanned code may be a member's card.
const itemGlance = route({
  id: 'circulation.desk.items.glance',
  method: 'POST',
  path: `${API}/items/glance`,
  permission: 'circulation.desk.use',
  branchParam: 'branchId',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: BranchParams,
  body: DeskItemGlanceBody,
  handler: async (rc) => {
    const body: DeskItemGlance = await deskItemGlance(rc.db.db, { barcode: rc.body.barcode });
    return { body };
  },
});

export const DESK_ROUTES: RouteDecl[] = [
  membersLookup,
  membersSearch,
  memberPanel,
  renewAll,
  loansCreate,
  returnsCreate,
  loansRenew,
  // ---- Komunitas (circulation core) ----
  loansVoid,
  loansLost,
  loansDue,
  inLibraryUses,
  // ---- Komunitas (staff screens' data) ----
  itemGlance,
];
