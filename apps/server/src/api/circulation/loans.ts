import { can, listLoans, loanClassNames, searchLoans } from '@altis/core';
import { LoanListQuery, LoanSearchBody, type LoanClassesResponse, type LoanListResponse } from '@altis/shared/api/circulation';
import { route, type RouteDecl } from '../../http/route.js';

// The loan records of every member (`circulation.records.read`, library-wide):
//
//   GET circulation/loans   LoanListQuery → LoanListResponse
//
// A member's open loans (`state=open&memberId=`), their history (`state=closed&memberId=`) and the overdue list
// (`state=overdue`, by branch, member type and days late). No personal value is a parameter: a member is named by id.
//
//   POST circulation/loans/search    LoanSearchBody → LoanListResponse      read, tx self
//   GET  circulation/loans/classes   → LoanClassesResponse
//
// The search (Terlambat & Jatuh Tempo) narrows by the member's number or name and class, so it is a POST read; a
// member's phone comes with it only for a caller who also holds `members.records.read`.

const loansList = route({
  id: 'circulation.loans.list',
  method: 'GET',
  path: '/api/v1/circulation/loans',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: LoanListQuery,
  handler: async (rc) => {
    const body: LoanListResponse = await listLoans(rc.db.db, rc.query, rc.now);
    return { body };
  },
});

// ---- Komunitas (staff screens' data) ----
const loansSearch = route({
  id: 'circulation.loans.search',
  method: 'POST',
  path: '/api/v1/circulation/loans/search',
  permission: 'circulation.records.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: LoanSearchBody,
  handler: async (rc) => {
    const grants = rc.auth?.grants;
    const withPhone = grants !== undefined && can(grants, 'members.records.read');
    const body: LoanListResponse = await searchLoans(rc.db.db, rc.body, rc.now, { withPhone });
    return { body };
  },
});

const loansClasses = route({
  id: 'circulation.loans.classes',
  method: 'GET',
  path: '/api/v1/circulation/loans/classes',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const body: LoanClassesResponse = { items: await loanClassNames(rc.db.db) };
    return { body };
  },
});

export const LOAN_LIST_ROUTES: RouteDecl[] = [loansList, loansSearch, loansClasses];
