import { MATRIX as Catalog } from './komunitas-catalog.js';
import { MATRIX as Documents } from './komunitas-documents.js';
import { MATRIX as Evidence } from './komunitas-evidence.js';
import { MATRIX as Periods } from './komunitas-periods.js';
import { MATRIX as Registers } from './komunitas-registers.js';
import { MATRIX as Reports } from './komunitas-reports.js';
import { MATRIX as Results } from './komunitas-results.js';
import { MATRIX as SlimsUsage } from './komunitas-slims-usage.js';
import { MATRIX as Usage } from './komunitas-usage.js';
import { mergeAreaMatrices, type AreaMatrix } from './catalog.js';

// The community rows of the permission matrix (reports and accreditation): one file per area
// (matrix/komunitas-<area>.ts), each filled by the change that owns the routes, merged here and spread once into
// db/matrix.test.ts (CATALOG) and matrix-fixtures.ts (MATRIX_FIXTURES, EXPECTED_MAINTENANCE, EXPECTED_SYSTEM_ROUTES),
// so that no later change edits those shared files. The same rules as matrix/catalog.ts: an area file uses the
// helpers of matrix-fixtures.ts inside its fixture functions only.

/** The areas, in the order of their routes in ALL_ROUTES (the reports, then the accreditation workspace). */
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
});

/** Every community area, merged. */
export const KOMUNITAS_MATRIX: AreaMatrix = mergeAreaMatrices(AREAS);

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
