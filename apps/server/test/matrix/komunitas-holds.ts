import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedMember } from './komunitas-members.js';

// The matrix rows, fixtures and maintenance entries of holds (the desk's holds and hold shelf at a branch, the hold
// list): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order.
// Every route is `deny` in maintenance and none is a `system` route. The desk routes are branch-scoped (`@branchId`).
//
// Each call gets rows of its own (a branch, a record with a copy, members, a hold) seeded straight into the tables, so
// that a super admin's call succeeds (audit once) whatever the personas before it did.

const trail = (s: MatrixSeed) => ({ created_at: s.now, created_by: null, updated_at: s.now, updated_by: null });

const unique = (prefix: string): string => `${prefix}${newId().slice(-12)}`;

async function seedBranch(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = unique('MH');
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return id;
}

/** A live record (material type BUKU) with one copy (collection type UMUM) in `branchId`: the record, the copy, its barcode. */
async function seedCopy(s: MatrixSeed, branchId: string): Promise<{ recordId: string; itemId: string; barcode: string }> {
  const recordId = newId();
  const itemId = newId();
  const barcode = unique('HX-');
  const buku = (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const umum = (await s.h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
  await s.h.db
    .insertInto('records')
    .values({
      id: recordId,
      material_type_id: buku,
      title: 'Cantuman Reservasi Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman reservasi matriks',
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
  await s.h.db
    .insertInto('items')
    .values({
      id: itemId,
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
  return { recordId, itemId, barcode };
}

/** An open loan of `itemId` (so that the title has no copy on the shelf). */
async function seedLoan(s: MatrixSeed, branchId: string, itemId: string, recordId: string): Promise<void> {
  await s.h.db
    .insertInto('loans')
    .values({
      id: newId(),
      item_id: itemId,
      open_item_id: itemId,
      record_id: recordId,
      member_id: (await seedMember(s)).id,
      branch_id: branchId,
      policy_id: null,
      loaned_on: '2026-10-24',
      loaned_at: s.now - 86_400_000,
      due_on: '2026-10-31',
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
      ...trail(s),
    })
    .execute();
}

/**
 * A hold of a new member on `recordId` at `branchId`, `waiting`, an expired one whose copy still waits to be cleared, or
 * a ready one whose copy is kept on the hold shelf.
 */
async function seedHold(s: MatrixSeed, branchId: string, recordId: string, o: { expiredCopy?: string; readyCopy?: string } = {}): Promise<string> {
  const id = newId();
  const memberId = (await seedMember(s)).id;
  const expired = o.expiredCopy !== undefined;
  const ready = o.readyCopy !== undefined;
  await s.h.db
    .insertInto('holds')
    .values({
      id,
      record_id: recordId,
      item_id: o.expiredCopy ?? null,
      member_id: memberId,
      pickup_branch_id: branchId,
      status: expired ? 'expired' : ready ? 'ready' : 'waiting',
      active_key: expired ? null : `${memberId}:${recordId}`,
      trap_item_id: o.readyCopy ?? null,
      placed_on: '2026-10-20',
      placed_at: s.now - 5 * 86_400_000,
      placed_by: null,
      source: 'desk',
      expires_on: null,
      ready_at: expired ? s.now - 4 * 86_400_000 : ready ? s.now : null,
      pickup_until: expired ? '2026-10-23' : ready ? '2026-11-05' : null,
      closed_at: expired ? s.now - 86_400_000 : null,
      close_reason: expired ? 'expired_pickup' : null,
      shelf_cleared_at: null,
      loan_id: null,
      ...trail(s),
    })
    .execute();
  return id;
}

const DESK = 'P:circulation.desk.use@branchId';
const deskWrite = (action: string): string => `${DESK} | - | - | write | deny | store | circulation.hold.${action} | handler | -`;
const DESK_API = '/api/v1/branches/:branchId/circulation';

const rows: Record<string, string> = {
  'circulation.desk.holds.create': `POST ${DESK_API}/holds | ${deskWrite('create')}`,
  'circulation.desk.holds.cancel': `POST ${DESK_API}/holds/:id/cancel | ${deskWrite('cancel')}`,
  'circulation.desk.holds.ready': `POST ${DESK_API}/holds/:id/ready | ${deskWrite('ready')}`,
  'circulation.desk.hold_shelf.get': `GET ${DESK_API}/hold-shelf | ${DESK} | - | - | read | deny | none | null | - | -`,
  'circulation.desk.hold_shelf.clear': `POST ${DESK_API}/hold-shelf/:holdId/clear | ${deskWrite('shelf_clear')}`,
  'circulation.holds.list': 'GET /api/v1/circulation/holds | P:circulation.records.read | - | - | read | deny | none | null | - | -',
  'circulation.desk.holds.slip': `GET ${DESK_API}/holds/:id/slip | ${DESK} | - | - | read | deny | none | null | - | -`,
};

const fixtures: Record<string, MatrixFixture> = {
  'circulation.desk.holds.create': async (s) => {
    const branchId = await seedBranch(s);
    const copy = await seedCopy(s, branchId);
    await seedLoan(s, branchId, copy.itemId, copy.recordId);
    return { params: { branchId }, body: { memberId: (await seedMember(s)).id, recordId: copy.recordId } };
  },
  'circulation.desk.holds.cancel': async (s) => {
    const branchId = await seedBranch(s);
    const copy = await seedCopy(s, branchId);
    return { params: { branchId, id: await seedHold(s, branchId, copy.recordId) } };
  },
  'circulation.desk.holds.ready': async (s) => {
    const branchId = await seedBranch(s);
    const copy = await seedCopy(s, branchId);
    return { params: { branchId, id: await seedHold(s, branchId, copy.recordId) }, body: { barcode: copy.barcode } };
  },
  'circulation.desk.hold_shelf.get': async (s) => ({ params: { branchId: await seedBranch(s) } }),
  'circulation.desk.hold_shelf.clear': async (s) => {
    const branchId = await seedBranch(s);
    const copy = await seedCopy(s, branchId);
    return { params: { branchId, holdId: await seedHold(s, branchId, copy.recordId, { expiredCopy: copy.itemId }) } };
  },
  'circulation.holds.list': async () => ({ query: { status: 'active' } }),
  'circulation.desk.holds.slip': async (s) => {
    const branchId = await seedBranch(s);
    const copy = await seedCopy(s, branchId);
    return { params: { branchId, id: await seedHold(s, branchId, copy.recordId, { readyCopy: copy.itemId }) }, query: { paper: '58' } };
  },
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
};
