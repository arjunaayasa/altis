import type { RouteDecl } from '../../http/route.js';
import { CALENDAR_ROUTES } from './calendar.js';
import { DESK_ROUTES } from './desk.js';
import { LOAN_LIST_ROUTES } from './loans.js';
import { POLICY_ROUTES } from './policies.js';

// The circulation API (one list per area): the desk at a branch, the loan list, the loan rules. Joined into ALL_ROUTES
// through KOMUNITAS_ROUTES (routes.ts), after the members API.

export const CIRCULATION_ROUTES: RouteDecl[] = [
  ...DESK_ROUTES,
  ...LOAN_LIST_ROUTES,
  ...POLICY_ROUTES,
  // ---- Komunitas (circulation core) ----
  ...CALENDAR_ROUTES,
];
