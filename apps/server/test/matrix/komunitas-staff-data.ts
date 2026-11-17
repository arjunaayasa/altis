import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch, seedItem } from './komunitas-circulation.js';

// The matrix rows and fixtures of the data the staff screens show beside their lists: the overdue and due-soon search
// and its class filter (the loan records' permission), the member list's class filter (the member records'), and what
// the desk may say about a scanned item under a refusal (the desk permission at the branch). Reads only: no audit,
// `deny` in maintenance as every read of the community API.

const rows: Record<string, string> = {
  'circulation.loans.search': 'POST /api/v1/circulation/loans/search | P:circulation.records.read | - | - | read | deny | none | null | self | -',
  'circulation.loans.classes': 'GET /api/v1/circulation/loans/classes | P:circulation.records.read | - | - | read | deny | none | null | - | -',
  'members.classes': 'GET /api/v1/members/classes | P:members.records.read | - | - | read | deny | none | null | - | -',
  'circulation.desk.items.glance': 'POST /api/v1/branches/:branchId/circulation/items/glance | P:circulation.desk.use@branchId | - | - | read | deny | none | null | self | -',
};

const fixtures: Record<string, MatrixFixture> = {
  'circulation.loans.search': async () => ({ body: { tab: 'due_soon', q: 'Matriks' } }),
  'circulation.loans.classes': async () => ({}),
  'members.classes': async () => ({}),
  'circulation.desk.items.glance': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId }, body: { barcode: (await seedItem(s, branchId)).barcode } };
  },
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
