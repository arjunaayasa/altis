import { DeskMemberLookupBody, DeskMemberSearchBody, LoanBody, ReturnBody } from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';
import { notImplemented } from '../not-implemented.js';

// The circulation desk, at a branch (`circulation.desk.use` at `:branchId`):
//
//   POST branches/:branchId/circulation/members/lookup               DeskMemberLookupBody → DeskMemberView     read, tx self
//   POST branches/:branchId/circulation/members/search               DeskMemberSearchBody → DeskMemberSearchResponse  read, tx self
//   GET  branches/:branchId/circulation/members/:memberId            → DeskMemberView
//   POST branches/:branchId/circulation/members/:memberId/renew-all  (no body) → RenewAllResponse  also circulation.loan.renew
//   POST branches/:branchId/circulation/loans                        LoanBody → 201 LoanResponse    circulation.loan.create
//   POST branches/:branchId/circulation/returns                      ReturnBody → ReturnResponse    circulation.loan.return
//   POST branches/:branchId/circulation/loans/:id/renew              (no body) → RenewResponse      circulation.loan.renew
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
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
});

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
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
});

export const DESK_ROUTES: RouteDecl[] = [membersLookup, membersSearch, memberPanel, renewAll, loansCreate, returnsCreate, loansRenew];
