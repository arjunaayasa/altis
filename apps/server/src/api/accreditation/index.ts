import type { RouteDecl } from '../../http/route.js';
import { DOCUMENT_ROUTES } from './documents.js';
import { EVIDENCE_ROUTES } from './evidence.js';
import { PERIOD_ROUTES } from './periods.js';
import { REGISTER_ROUTES } from './registers.js';
import { RESULT_ROUTES } from './results.js';
import { SLIMS_USAGE_ROUTES } from './slims-usage.js';
import { USAGE_ROUTES } from './usage.js';

// The accreditation API (one list per area, each filled by the change that owns it), in this order: the periods come
// before the registers so that `accreditation/periods/...` is matched first, and every register has literal paths.
// Joined into ALL_ROUTES through KOMUNITAS_ROUTES (routes.ts).

export const ACCREDITATION_ROUTES: RouteDecl[] = [
  ...PERIOD_ROUTES,
  ...REGISTER_ROUTES,
  ...EVIDENCE_ROUTES,
  ...USAGE_ROUTES,
  ...RESULT_ROUTES,
  ...SLIMS_USAGE_ROUTES,
  ...DOCUMENT_ROUTES,
];
