import type { RouteDecl } from '../../http/route.js';
import { MEMBER_CLEARANCE_ROUTES } from './clearances.js';
import { MEMBER_IMPORT_ROUTES } from './imports.js';
import { MEMBER_ROUTES } from './members.js';
import { MEMBER_OPS_ID_ROUTES, MEMBER_OPS_ROUTES } from './ops.js';
import { MEMBER_TYPE_ROUTES } from './types.js';
// ---- Komunitas (member area) ----
import { MEMBER_PASSWORD_ROUTES } from './password.js';

// The members API (one list per area), in this order: the literal paths `members/types/...`, `members/imports/...` and
// `members/clearances/...` before `members/:id`. Joined into ALL_ROUTES through KOMUNITAS_ROUTES (routes.ts).

export const MEMBERS_ROUTES: RouteDecl[] = [
  ...MEMBER_TYPE_ROUTES,
  ...MEMBER_IMPORT_ROUTES,
  // ---- Komunitas (circulation core) ----
  ...MEMBER_CLEARANCE_ROUTES,
  // ---- Komunitas K2 (members extended): the literal paths first, the `members/:id/...` ones after the member routes ----
  ...MEMBER_OPS_ROUTES,
  ...MEMBER_ROUTES,
  ...MEMBER_OPS_ID_ROUTES,
  // ---- Komunitas (member area) ----
  ...MEMBER_PASSWORD_ROUTES,
];
