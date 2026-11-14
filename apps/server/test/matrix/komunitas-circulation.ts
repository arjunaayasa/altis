import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedMember, seedMemberType } from './komunitas-members.js';

// The matrix rows, fixtures and maintenance entries of circulation (the desk at a branch, the loan list, the loan
// rules): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same
// order. Every route is `deny` in maintenance and none is a `system` route. The desk is branch-scoped (`@branchId`).
//
// Each call gets rows of its own (a branch, a member, an item, a loan, a rule) seeded straight into the tables, so that
// a super admin's call succeeds (audit once) whatever the personas before it did. The routes whose handlers are not
// written yet are `pending`: the gate outcomes are checked, the audit-once call is listed as to do.

/** The trail columns of a seeded row. */
const trail = (s: MatrixSeed) => ({ created_at: s.now, created_by: null, updated_at: s.now, updated_by: null });

/** A code or barcode no other call uses. */
const unique = (prefix: string): string => `${prefix}${newId().slice(-12)}`;

/** A live branch of its own; its id. */
async function seedBranch(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = unique('MC');
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return id;
}

/** A live record of the seeded material type BUKU; its id. */
async function seedRecord(s: MatrixSeed): Promise<string> {
  const id = newId();
  const buku = (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: buku,
      title: 'Cantuman Sirkulasi Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman sirkulasi matriks',
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: null,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      source: 'manual',
      merged_into: null,
      changed_at: s.now,
      archived_at: null,
      ...trail(s),
    })
    .execute();
  return id;
}

/** An `available` item of the seeded collection type UMUM, of a record of its own, in `branchId`. */
async function seedItem(s: MatrixSeed, branchId: string): Promise<{ id: string; recordId: string; barcode: string }> {
  const id = newId();
  const barcode = unique('SX-');
  const recordId = await seedRecord(s);
  const umum = (await s.h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
  await s.h.db
    .insertInto('items')
    .values({
      id,
      record_id: recordId,
      branch_id: branchId,
      barcode_display: barcode,
      barcode_key: barcode,
      inventory_no: null,
      call_number: null,
      location_id: null,
      collection_type_id: umum,
      status: 'available',
      status_note: null,
      acq_source: null,
      order_no: null,
      order_date: null,
      received_date: null,
      invoice_date: null,
      supplier_id: null,
      invoice_no: null,
      price: null,
      currency: null,
      note: null,
      archived_at: null,
      ...trail(s),
    })
    .execute();
  return { id, recordId, barcode };
}

/** An open loan, lent two days before `s.now`, of a new item in `branchId` to a new member; its id and the item's barcode. */
async function seedOpenLoan(s: MatrixSeed, branchId: string): Promise<{ id: string; barcode: string; memberId: string }> {
  const id = newId();
  const item = await seedItem(s, branchId);
  const member = await seedMember(s);
  await s.h.db
    .insertInto('loans')
    .values({
      id,
      item_id: item.id,
      open_item_id: item.id,
      record_id: item.recordId,
      member_id: member.id,
      branch_id: branchId,
      policy_id: null,
      loaned_on: '2026-10-24',
      loaned_at: s.now - 2 * 86_400_000,
      due_on: '2026-10-31',
      renewals: 0,
      last_renewed_on: null,
      returned_on: null,
      returned_at: null,
      return_branch_id: null,
      outcome: null,
      loan_days: 7,
      renew_limit: 1,
      grace_days: 0,
      fine_per_day_minor: 0,
      fine_cap_minor: null,
      currency: 'IDR',
      overrides: null,
      override_note: null,
      loaned_by: null,
      returned_by: null,
      source: 'desk',
      stat_ddc: null,
      stat_material_type_id: null,
      stat_collection_type_id: null,
      stat_location_id: null,
      stat_member_type_id: null,
      stat_accred_group: null,
      stat_class_name: null,
      version: 0,
      ...trail(s),
    })
    .execute();
  return { id, barcode: item.barcode, memberId: member.id };
}

/** A live loan rule of its own, for a member type of its own; its id. */
async function seedPolicy(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = unique('AP');
  const typeId = await seedMemberType(s);
  await s.h.db
    .insertInto('policies')
    .values({
      id,
      code_display: code,
      code_key: code,
      name: 'Aturan Matriks',
      member_type_id: typeId,
      collection_type_id: null,
      material_type_id: null,
      branch_id: null,
      scope_key: `${typeId}/*/*/*`,
      loanable: 1,
      loan_days: 7,
      loan_limit: null,
      renew_limit: 1,
      fine_per_day_minor: 0,
      fine_cap_minor: null,
      grace_days: 0,
      currency: 'IDR',
      archived_at: null,
      version: 0,
      ...trail(s),
    })
    .execute();
  return id;
}

const DESK = 'P:circulation.desk.use@branchId';
const POST_READ = `${DESK} | - | - | read | deny | none | null | self | -`;
const deskWrite = (action: string): string => `${DESK} | - | - | write | deny | store | circulation.loan.${action} | handler | -`;
const rules = (action: string): string => `P:circulation.policies.manage | - | - | write | deny | store | circulation.policy.${action} | handler | -`;

const DESK_API = '/api/v1/branches/:branchId/circulation';
const RULES_API = '/api/v1/circulation/policies';

const rows: Record<string, string> = {
  'circulation.desk.members.lookup': `POST ${DESK_API}/members/lookup | ${POST_READ}`,
  'circulation.desk.members.search': `POST ${DESK_API}/members/search | ${POST_READ}`,
  'circulation.desk.members.get': `GET ${DESK_API}/members/:memberId | ${DESK} | - | - | read | deny | none | null | - | -`,
  'circulation.desk.members.renew_all': `POST ${DESK_API}/members/:memberId/renew-all | ${DESK} | - | - | write | deny | store | null | handler | also:circulation.loan.renew`,
  'circulation.desk.loans.create': `POST ${DESK_API}/loans | ${deskWrite('create')}`,
  'circulation.desk.returns.create': `POST ${DESK_API}/returns | ${deskWrite('return')}`,
  'circulation.desk.loans.renew': `POST ${DESK_API}/loans/:id/renew | ${deskWrite('renew')}`,
  'circulation.loans.list': 'GET /api/v1/circulation/loans | P:circulation.records.read | - | - | read | deny | none | null | - | -',
  'circulation.policies.list': `GET ${RULES_API} | P:circulation.policies.manage | - | - | read | deny | none | null | - | -`,
  'circulation.policies.create': `POST ${RULES_API} | ${rules('create')}`,
  'circulation.policies.update': `PATCH ${RULES_API}/:id | ${rules('update')}`,
  'circulation.policies.archive': `DELETE ${RULES_API}/:id | ${rules('archive')}`,
};

const fixtures: Record<string, MatrixFixture> = {
  'circulation.desk.members.lookup': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { no: (await seedMember(s)).memberNo } }),
  'circulation.desk.members.search': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { q: 'Matriks' } }),
  'circulation.desk.members.get': async (s) => ({ params: { branchId: await seedBranch(s), memberId: (await seedMember(s)).id } }),
  'circulation.desk.members.renew_all': async (s) => {
    const branchId = await seedBranch(s);
    const loan = await seedOpenLoan(s, branchId);
    return { params: { branchId, memberId: loan.memberId } };
  },
  'circulation.desk.loans.create': async (s) => {
    const branchId = await seedBranch(s);
    const item = await seedItem(s, branchId);
    return { params: { branchId }, body: { memberId: (await seedMember(s)).id, barcode: item.barcode } };
  },
  'circulation.desk.returns.create': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId }, body: { barcode: (await seedOpenLoan(s, branchId)).barcode } };
  },
  'circulation.desk.loans.renew': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: (await seedOpenLoan(s, branchId)).id } };
  },
  'circulation.loans.list': async () => ({ query: { state: 'overdue' } }),
  'circulation.policies.list': async () => ({ query: { includeArchived: 'false' } }),
  'circulation.policies.create': async (s) => ({
    body: { code: unique('NP'), name: 'Aturan Baru', memberTypeId: await seedMemberType(s), loanDays: 14, loanLimit: null, renewLimit: 2 },
  }),
  'circulation.policies.update': async (s) => ({ params: { id: await seedPolicy(s) }, body: { version: 0, name: 'Aturan Diubah' } }),
  'circulation.policies.archive': async (s) => ({ params: { id: await seedPolicy(s) }, body: { version: 0 } }),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
  // Every handler of this area is still to be written.
  pending: Object.keys(rows),
};
