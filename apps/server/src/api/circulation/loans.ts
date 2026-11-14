import { LoanListQuery } from '@altis/shared/api/circulation';
import { route, type RouteDecl } from '../../http/route.js';
import { notImplemented } from '../not-implemented.js';

// The loan records of every member (`circulation.records.read`, library-wide):
//
//   GET circulation/loans   LoanListQuery → LoanListResponse
//
// A member's open loans (`state=open&memberId=`), their history (`state=closed&memberId=`) and the overdue list
// (`state=overdue`, by branch, member type and days late). No personal value is a parameter: a member is named by id.

const loansList = route({
  id: 'circulation.loans.list',
  method: 'GET',
  path: '/api/v1/circulation/loans',
  permission: 'circulation.records.read',
  idempotency: 'none',
  audit: null,
  query: LoanListQuery,
  handler: notImplemented,
});

export const LOAN_LIST_ROUTES: RouteDecl[] = [loansList];
