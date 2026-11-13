import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the evidence files: one row per route id in the row
// format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Empty until the routes are written;
// the change that adds them fills this file.

export const MATRIX: AreaMatrix = { rows: {}, fixtures: {}, maintenance: {}, systemRoutes: [] };
