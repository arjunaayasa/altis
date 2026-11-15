import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows and fixtures of the dashboard's library figures: one read per module, behind that module's read
// permission; `deny` in maintenance as every read of the community API; no `system` route, no audit.

const read = (permission: string): string => `P:${permission} | - | - | read | deny | none | null | - | -`;

const rows: Record<string, string> = {
  'catalog.statistics': `GET /api/v1/catalog/statistics | ${read('catalog.records.read')}`,
  'members.statistics': `GET /api/v1/members/statistics | ${read('members.records.read')}`,
  'visits.statistics': `GET /api/v1/visits/statistics | ${read('visits.records.read')}`,
  'circulation.statistics': `GET /api/v1/circulation/statistics | ${read('circulation.records.read')}`,
};

const none: MatrixFixture = async () => ({});

const fixtures: Record<string, MatrixFixture> = Object.fromEntries(Object.keys(rows).map((id) => [id, none]));

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
