import { MATRIX as Catalog } from './komunitas-catalog.js';
import { MATRIX as Charges } from './komunitas-charges.js';
import { MATRIX as CircCore } from './komunitas-circ-core.js';
import { MATRIX as Circulation } from './komunitas-circulation.js';
// ---- Komunitas (member, visit and circulation reports) ----
import { MATRIX as CircReports } from './komunitas-circ-reports.js';
import { MATRIX as Documents } from './komunitas-documents.js';
import { MATRIX as Evidence } from './komunitas-evidence.js';
import { MATRIX as Holds } from './komunitas-holds.js';
// ---- Komunitas (member area) ----
import { MATRIX as MemberArea } from './komunitas-member-area.js';
import { MATRIX as Members } from './komunitas-members.js';
// ---- Komunitas (notices) ----
import { MATRIX as Notices } from './komunitas-notices.js';
import { MATRIX as MembersExt } from './komunitas-members-ext.js';
import { MATRIX as Periods } from './komunitas-periods.js';
import { MATRIX as Registers } from './komunitas-registers.js';
import { MATRIX as Reports } from './komunitas-reports.js';
import { MATRIX as Results } from './komunitas-results.js';
import { MATRIX as SlimsUsage } from './komunitas-slims-usage.js';
// ---- Komunitas K4 (stocktake) ----
import { MATRIX as Stocktake } from './komunitas-stocktake.js';
import { MATRIX as Usage } from './komunitas-usage.js';
import { mergeAreaMatrices, type AreaMatrix } from './catalog.js';

// The community rows of the permission matrix (reports and accreditation): one file per area
// (matrix/komunitas-<area>.ts), each filled by the change that owns the routes, merged here and spread once into
// db/matrix.test.ts (CATALOG) and matrix-fixtures.ts (MATRIX_FIXTURES, EXPECTED_MAINTENANCE, EXPECTED_SYSTEM_ROUTES),
// so that no later change edits those shared files. The same rules as matrix/catalog.ts: an area file uses the
// helpers of matrix-fixtures.ts inside its fixture functions only.

/**
 * The areas, in the order of their routes in ALL_ROUTES (the reports, the accreditation workspace, then members and
 * circulation).
 */
const AREAS: Readonly<Record<string, AreaMatrix>> = Object.freeze({
  reports: Reports,
  periods: Periods,
  registers: Registers,
  evidence: Evidence,
  usage: Usage,
  results: Results,
  'slims-usage': SlimsUsage,
  documents: Documents,
  catalog: Catalog,
  // ---- Komunitas (members and circulation) ----
  members: Members,
  circulation: Circulation,
  // ---- Komunitas (holds) ----
  holds: Holds,
  // ---- Komunitas (circulation core) ----
  'circ-core': CircCore,
  // ---- Komunitas K2 (members extended and visits) ----
  'members-ext': MembersExt,
  // ---- Komunitas (member area) ----
  'member-area': MemberArea,
  // ---- Komunitas (charges and payments) ----
  charges: Charges,
  // ---- Komunitas (member, visit and circulation reports) ----
  'circ-reports': CircReports,
  // ---- Komunitas (notices) ----
  notices: Notices,
  // ---- Komunitas K4 (stocktake) ----
  stocktake: Stocktake,
});

/** Every community area, merged. */
export const KOMUNITAS_MATRIX: AreaMatrix = mergeAreaMatrices(AREAS);

/**
 * The community route ids whose handlers are not written yet, from the areas' `pending`: db/matrix.test.ts lists their
 * audit-once call as to do.
 *
 * @throws Error naming a pending route id without a row in its area
 */
export const KOMUNITAS_PENDING_ROUTES: readonly string[] = Object.freeze(
  Object.entries(AREAS).flatMap(([area, m]) =>
    (m.pending ?? []).map((id) => {
      if (!Object.hasOwn(m.rows, id)) throw new Error(`matrix ${area}: pending route ${id} has no row`);
      return id;
    }),
  ),
);

/**
 * The community route ids declared `mode: 'system'`, from the areas' `systemRoutes`.
 *
 * @throws Error naming a system route id without a row in its area, or one two areas list
 */
export const KOMUNITAS_SYSTEM_ROUTES: readonly string[] = Object.freeze(
  Object.entries(AREAS).flatMap(([area, m]) =>
    (m.systemRoutes ?? []).map((id) => {
      if (!Object.hasOwn(m.rows, id)) throw new Error(`matrix ${area}: system route ${id} has no row`);
      return id;
    }),
  ),
);
