import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch } from './komunitas-circulation.js';

// The matrix rows and fixtures of Beranda's library figures: today at a desk's branch (the desk permission at that
// branch) and the library sections (any signed-in staff user; each section filtered by its data's permission inside
// the handler). `deny` in maintenance as every read of the community API; no `system` route, no audit.

const rows: Record<string, string> = {
  'dashboard.desk': `GET /api/v1/branches/:branchId/dashboard | P:circulation.desk.use@branchId | - | - | read | deny | none | null | - | -`,
  'dashboard.library': `GET /api/v1/dashboard/library | pub+s | - | - | read | deny | none | null | - | -`,
};

const fixtures: Record<string, MatrixFixture> = {
  'dashboard.desk': async (s) => ({ params: { branchId: await seedBranch(s) } }),
  'dashboard.library': async () => ({}),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
