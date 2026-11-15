import type { RouteDecl } from '../../http/route.js';
import { CALENDAR_ROUTES } from './calendar.js';
// ---- Komunitas (charges and payments) ----
import { CHARGE_ROUTES } from './charges.js';
import { DESK_ROUTES } from './desk.js';
// ---- Komunitas (holds) ----
import { HOLD_ROUTES } from './holds.js';
import { LOAN_LIST_ROUTES } from './loans.js';
// ---- Komunitas (notices) ----
import { NOTICE_ROUTES } from './notices.js';
import { POLICY_ROUTES } from './policies.js';
// ---- Komunitas (member, visit and circulation reports) ----
import { CIRCULATION_SUMMARY_ROUTES } from './summary.js';

// The circulation API (one list per area): the desk at a branch, the loan list, the loan rules, the holds. Joined into ALL_ROUTES
// through KOMUNITAS_ROUTES (routes.ts), after the members API.

export const CIRCULATION_ROUTES: RouteDecl[] = [
  ...DESK_ROUTES,
  ...LOAN_LIST_ROUTES,
  ...POLICY_ROUTES,
  ...HOLD_ROUTES,
  // ---- Komunitas (circulation core) ----
  ...CALENDAR_ROUTES,
  // ---- Komunitas (charges and payments) ----
  ...CHARGE_ROUTES,
  // ---- Komunitas (member, visit and circulation reports) ----
  ...CIRCULATION_SUMMARY_ROUTES,
  // ---- Komunitas (notices) ----
  ...NOTICE_ROUTES,
];
