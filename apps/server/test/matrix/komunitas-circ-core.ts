import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch, seedItem, seedOpenLoan } from './komunitas-circulation.js';
import { seedMember } from './komunitas-members.js';

// The matrix rows, fixtures and maintenance entries of the circulation core: the desk's void, lost, due date and
// read-in-place routes, the "which rule applies" tool, the library calendar and the clearance letters. One row per route
// id in db/matrix.test.ts's row format, one fixture per route in the same order. Every route is `deny` in maintenance and
// none is a `system` route. Each call gets rows of its own, so that a super admin's call succeeds (audit once).

const DESK = 'P:circulation.desk.use@branchId';
const DESK_API = '/api/v1/branches/:branchId/circulation';
const RULES = 'P:circulation.policies.manage';
const CALENDAR_API = '/api/v1/circulation/calendar';
const MEMBERS = 'P:members.records.manage';

const rows: Record<string, string> = {
  'circulation.desk.loans.void': `POST ${DESK_API}/loans/:id/void | ${DESK} | - | - | write | deny | store | circulation.loan.void | handler | -`,
  'circulation.desk.loans.lost': `POST ${DESK_API}/loans/:id/lost | ${DESK} | - | - | write | deny | store | circulation.loan.lost | handler | -`,
  'circulation.desk.loans.due': `PATCH ${DESK_API}/loans/:id/due | P:circulation.desk.override@branchId | - | - | write | deny | store | circulation.loan.due_change | handler | -`,
  'circulation.desk.in_library_uses.create': `POST ${DESK_API}/in-library-uses | ${DESK} | - | - | write | deny | store | null | handler | -`,
  'circulation.policies.resolve': `GET /api/v1/circulation/policies/resolve | ${RULES} | - | - | read | deny | none | null | - | -`,
  'circulation.calendar.get': `GET ${CALENDAR_API} | pub+s | - | - | read | deny | none | null | - | -`,
  'circulation.calendar.create': `POST ${CALENDAR_API} | ${RULES} | - | - | write | deny | store | circulation.calendar.create | handler | -`,
  'circulation.calendar.update': `PATCH ${CALENDAR_API}/:id | ${RULES} | - | - | write | deny | store | circulation.calendar.update | handler | -`,
  'circulation.calendar.archive': `DELETE ${CALENDAR_API}/:id | ${RULES} | - | - | write | deny | store | circulation.calendar.archive | handler | -`,
  'members.clearances.check': `POST /api/v1/members/clearances/check | ${MEMBERS} | - | - | read | deny | none | null | self | -`,
  'members.clearances.issue': `POST /api/v1/members/clearances | ${MEMBERS} | - | - | write | deny | none | members.clearance.issue | self | -`,
  'members.clearances.list': `GET /api/v1/members/clearances | ${MEMBERS} | - | - | read | deny | none | null | - | -`,
  'members.clearances.pdf': `GET /api/v1/members/:id/clearances/:clearanceId/pdf | ${MEMBERS} | - | - | read | deny | none | null | - | -`,
  'members.clearances.void': `POST /api/v1/members/:id/clearances/:clearanceId/void | ${MEMBERS} | - | - | write | deny | store | members.clearance.void | handler | -`,
};

/** A loan lent just now by the caller (within the void window), in a branch of its own. */
async function freshLoan(s: MatrixSeed): Promise<{ branchId: string; id: string }> {
  const branchId = await seedBranch(s);
  const loan = await seedOpenLoan(s, branchId);
  await s.h.db
    .updateTable('loans')
    .set({ loaned_at: s.now, loaned_by: s.user?.id ?? null })
    .where('id', '=', loan.id)
    .execute();
  return { branchId, id: loan.id };
}

/** A live closed-days rule of its own; its id. */
async function seedCalendarRule(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('calendars')
    .values({
      id,
      branch_id: null,
      kind: 'dates',
      weekday: null,
      date_from: '2026-12-25',
      date_to: '2026-12-26',
      month_day_from: null,
      month_day_to: null,
      name: 'Libur Matriks',
      archived_at: null,
      version: 0,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/**
 * The sequence of the next seeded letter: of the year before the one the issuing route numbers in, counting down from
 * far above anything it hands out, so the two never meet.
 */
let seededSeq = 900_000_000;

/** A clearance letter of a new member, with a sequence of its own; the member's and the letter's ids. */
async function seedClearance(s: MatrixSeed): Promise<{ memberId: string; id: string }> {
  const member = await seedMember(s);
  const id = newId();
  const seq = seededSeq--;
  await s.h.db
    .insertInto('member_clearances')
    .values({
      id,
      member_id: member.id,
      year: 2025,
      seq,
      number_display: `BP/2025/${seq}`,
      issued_on: '2025-10-27',
      issued_at: s.now,
      issued_by: s.user?.id ?? newId(),
      purpose: 'graduation',
      voided_at: null,
      voided_by: null,
      void_reason: null,
    })
    .execute();
  return { memberId: member.id, id };
}

const fixtures: Record<string, MatrixFixture> = {
  'circulation.desk.loans.void': async (s) => {
    const loan = await freshLoan(s);
    return { params: { branchId: loan.branchId, id: loan.id } };
  },
  'circulation.desk.loans.lost': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: (await seedOpenLoan(s, branchId)).id }, body: { replacement: '75000', note: 'Hilang di bus' } };
  },
  'circulation.desk.loans.due': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: (await seedOpenLoan(s, branchId)).id }, body: { dueOn: '2026-11-20', note: 'Kegiatan sekolah' } };
  },
  'circulation.desk.in_library_uses.create': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId }, body: { barcode: (await seedItem(s, branchId)).barcode } };
  },
  'circulation.policies.resolve': async () => ({ query: {} }),
  'circulation.calendar.get': async () => ({ query: { from: '2026-12-01' } }),
  'circulation.calendar.create': async () => ({ body: { kind: 'dates', name: 'Libur Semester', dateFrom: '2026-12-21', dateTo: '2026-12-31' } }),
  'circulation.calendar.update': async (s) => ({ params: { id: await seedCalendarRule(s) }, body: { version: 0, name: 'Libur Diubah' } }),
  'circulation.calendar.archive': async (s) => ({ params: { id: await seedCalendarRule(s) }, body: { version: 0 } }),
  'members.clearances.check': async (s) => ({ body: { memberIds: [(await seedMember(s)).id] } }),
  'members.clearances.issue': async (s) => ({ body: { memberIds: [(await seedMember(s)).id], purpose: 'graduation', issuedOn: '2026-10-26' } }),
  'members.clearances.list': async () => ({ query: { year: '2026' } }),
  'members.clearances.pdf': async (s) => {
    const c = await seedClearance(s);
    return { params: { id: c.memberId, clearanceId: c.id } };
  },
  'members.clearances.void': async (s) => {
    const c = await seedClearance(s);
    return { params: { id: c.memberId, clearanceId: c.id }, body: { reason: 'Salah cetak' } };
  },
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
