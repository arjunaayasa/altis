import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch } from './komunitas-circulation.js';

// The matrix rows and fixtures of the member, visit and circulation reports' own route: the dashboard's numbers of the
// day at a desk's branch. The reports themselves go through the report routes (komunitas-reports.ts). `deny` in
// maintenance as every desk read; not a `system` route.

const rows: Record<string, string> = {
  'circulation.desk.summary': `GET /api/v1/branches/:branchId/circulation/summary | P:circulation.desk.use@branchId | - | - | read | deny | none | null | - | -`,
};

const fixtures: Record<string, MatrixFixture> = {
  'circulation.desk.summary': async (s) => ({ params: { branchId: await seedBranch(s) } }),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
