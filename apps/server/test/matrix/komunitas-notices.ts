import type { MatrixFixture } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch, seedOpenLoan } from './komunitas-circulation.js';

// The matrix rows, fixtures and maintenance entries of the member notices: the desk's manual reminder, the log and its
// status, and the settings screen's preview and test send. One row per route id in db/matrix.test.ts's row format, one
// fixture per route in the same order. Every route is `deny` in maintenance and none is a `system` route. A manual send
// gets a branch of its own with an open loan, so that a super admin's call succeeds (audit once).

const DESK = 'P:circulation.desk.use@branchId';
const RECORDS = 'P:circulation.records.read';

const rows: Record<string, string> = {
  'circulation.notices.send': `POST /api/v1/branches/:branchId/circulation/notices | ${DESK} | - | - | write | deny | store | circulation.notice.send | handler | -`,
  'circulation.notices.status': `GET /api/v1/circulation/notices/status | ${RECORDS} | - | - | read | deny | none | null | - | -`,
  'circulation.notices.list': `GET /api/v1/circulation/notices | ${RECORDS} | - | - | read | deny | none | null | - | -`,
  'circulation.notices.preview': 'POST /api/v1/circulation/notices/preview | P:system.settings.read | - | - | read | deny | none | null | self | -',
  'circulation.notices.test': 'POST /api/v1/circulation/notices/test | P:system.settings.manage | - | - | write | deny | none | circulation.notice.send | self | -',
};

const fixtures: Record<string, MatrixFixture> = {
  'circulation.notices.send': async (s) => {
    const branchId = await seedBranch(s);
    const loan = await seedOpenLoan(s, branchId);
    return { params: { branchId }, body: { memberIds: [loan.memberId], kind: 'due_soon' } };
  },
  'circulation.notices.status': async () => ({ query: {} }),
  'circulation.notices.list': async () => ({ query: {} }),
  'circulation.notices.preview': async () => ({ body: { kind: 'overdue', locale: 'id' } }),
  'circulation.notices.test': async () => ({ body: { kind: 'hold_ready', locale: 'en', to: 'uji@example.test' } }),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
