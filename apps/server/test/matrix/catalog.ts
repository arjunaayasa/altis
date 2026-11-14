import type { MatrixFixture } from '../matrix-fixtures.js';
import { MATRIX as Masters } from './catalog-masters.js';
import { MATRIX as Authorities } from './catalog-authorities.js';
import { MATRIX as Locations } from './catalog-locations.js';
import { MATRIX as Search } from './catalog-search.js';
import { MATRIX as Records } from './catalog-records.js';
import { MATRIX as Items } from './catalog-items.js';
import { MATRIX as Attachments } from './catalog-attachments.js';
import { MATRIX as Runs } from './catalog-runs.js';
import { MATRIX as Exchange } from './catalog-exchange.js';
import { MATRIX as Copy } from './catalog-copy.js';
import { MATRIX as Labels } from './catalog-labels.js';
import { MATRIX as Migration } from './catalog-migration.js';
import { MATRIX as PagesAdmin } from './catalog-pages-admin.js';
import { MATRIX as OpacShell } from './catalog-opac-shell.js';
import { MATRIX as OpacPages } from './catalog-opac-pages.js';
import { MATRIX as OpacSearch } from './catalog-opac-search.js';
import { MATRIX as OpacDetail } from './catalog-opac-detail.js';
import { MATRIX as Oai } from './catalog-oai.js';

// The Phase 2 rows of the permission matrix (Task 3): one file per area (matrix/catalog-<area>.ts), each filled by the
// task that owns the routes, merged here and spread once into db/matrix.test.ts (CATALOG) and matrix-fixtures.ts
// (MATRIX_FIXTURES, EXPECTED_MAINTENANCE), so that no later task edits those shared files. The coverage test there
// (one fixture per route of ALL_ROUTES, in the order of CATALOG) then covers every catalog route.
//
// matrix-fixtures.ts imports this file, and an area file may import helpers from matrix-fixtures.ts (seedBranch,
// seedUser, ...): that import is circular, so an area uses them inside its fixture functions only, never at its
// module's top level.

/**
 * One area of the matrix: route id → catalog row, route id → fixture, route id → its maintenance when not `deny`, and
 * the ids of its routes declared `mode: 'system'` (each listed in matrix-fixtures.ts's EXPECTED_SYSTEM_ROUTES).
 */
export interface AreaMatrix {
  rows: Record<string, string>;
  fixtures: Record<string, MatrixFixture>;
  maintenance: Record<string, 'allow' | 'restore-allow'>;
  // ---- Komunitas K1 (system routes) ----
  systemRoutes?: readonly string[];
}

/**
 * The areas merged in their order. Each area must have a fixture for every row and a row for every fixture and
 * maintenance entry, and no route id may be in two areas (a spread would silently keep one of them).
 *
 * @throws Error naming the route id otherwise
 */
export function mergeAreaMatrices(areas: Readonly<Record<string, AreaMatrix>>): AreaMatrix {
  const merged: AreaMatrix = { rows: {}, fixtures: {}, maintenance: {} };
  for (const [area, m] of Object.entries(areas)) {
    for (const id of Object.keys(m.rows)) if (!Object.hasOwn(m.fixtures, id)) throw new Error(`matrix ${area}: ${id} has a row and no fixture`);
    for (const id of Object.keys(m.fixtures)) if (!Object.hasOwn(m.rows, id)) throw new Error(`matrix ${area}: ${id} has a fixture and no row`);
    for (const id of Object.keys(m.maintenance)) {
      if (!Object.hasOwn(m.rows, id)) throw new Error(`matrix ${area}: ${id} has a maintenance entry and no row`);
    }
    for (const id of Object.keys(m.rows)) {
      if (Object.hasOwn(merged.rows, id)) throw new Error(`matrix ${area}: ${id} is in another area too`);
      merged.rows[id] = m.rows[id]!;
      merged.fixtures[id] = m.fixtures[id]!;
    }
    Object.assign(merged.maintenance, m.maintenance);
  }
  return merged;
}

/** Every Phase 2 area, in the order of the plan's route catalog files. */
export const CATALOG_MATRIX: AreaMatrix = mergeAreaMatrices({
  masters: Masters,
  authorities: Authorities,
  locations: Locations,
  search: Search,
  records: Records,
  items: Items,
  attachments: Attachments,
  runs: Runs,
  exchange: Exchange,
  copy: Copy,
  labels: Labels,
  migration: Migration,
  'pages-admin': PagesAdmin,
  'opac-shell': OpacShell,
  'opac-pages': OpacPages,
  'opac-search': OpacSearch,
  'opac-detail': OpacDetail,
  oai: Oai,
});
