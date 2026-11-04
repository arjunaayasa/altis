import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the items (Phase 2 Task 17; the plan's route catalog): one row
// per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route
// is `deny` in maintenance, so there is no maintenance entry. The writes are branch-scoped (`@branchId`).
//
// The fixtures seed what a call needs straight into the tables (a branch, a record, an item), each call its own, so
// that a super admin's call succeeds (audit once) whatever the personas before it did. Only types come from
// matrix-fixtures.ts: it imports this file through matrix/catalog.ts, so a value imported from it could still be
// unset while a test that loads matrix/catalog.ts first evaluates this module.

/** A live branch of its own; its id. */
async function seedBranch(s: MatrixSeed): Promise<{ id: string }> {
  const id = newId();
  const code = `MI${id.slice(-12)}`;
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return { id };
}

/** The id of the seeded collection type UMUM (§2.6). */
async function umumId(s: MatrixSeed): Promise<string> {
  return (await s.h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
}

/** A barcode no other call uses. */
const barcode = (): string => `MX-${newId().slice(-12)}`;

/** A live record of its own. */
async function seedRecord(s: MatrixSeed): Promise<string> {
  const id = newId();
  const buku = (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: buku,
      title: 'Cantuman Eksemplar Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman eksemplar matriks',
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
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** An `available` item (version 0) of a record of its own in `branchId`. */
async function seedItem(s: MatrixSeed, branchId: string): Promise<string> {
  const id = newId();
  const code = barcode();
  await s.h.db
    .insertInto('items')
    .values({
      id,
      record_id: await seedRecord(s),
      branch_id: branchId,
      barcode_display: code,
      barcode_key: code,
      inventory_no: null,
      call_number: null,
      location_id: null,
      collection_type_id: await umumId(s),
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
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A branch of its own, an item in it, and the item's path parameters. */
const branchItem = (body: (s: MatrixSeed) => Promise<unknown> | unknown): MatrixFixture => async (s) => {
  const branchId = (await seedBranch(s)).id;
  return { params: { branchId, id: await seedItem(s, branchId) }, body: await body(s) };
};

const MANAGE = 'P:catalog.items.manage@branchId | - | - | write | deny | store';

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.items.list': 'GET /api/v1/catalog/items | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.items.by_barcode': 'GET /api/v1/catalog/items/by-barcode | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.items.get': 'GET /api/v1/catalog/items/:id | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.items.create': `POST /api/v1/branches/:branchId/items | ${MANAGE} | catalog.item.create | handler | -`,
    'catalog.items.batch': `POST /api/v1/branches/:branchId/items/batch | ${MANAGE} | catalog.item.batch_create | handler | -`,
    'catalog.items.bulk': `POST /api/v1/branches/:branchId/items/bulk | ${MANAGE} | catalog.item.bulk_update | handler | -`,
    'catalog.items.update': `PATCH /api/v1/branches/:branchId/items/:id | ${MANAGE} | catalog.item.update | handler | -`,
    'catalog.items.archive': `DELETE /api/v1/branches/:branchId/items/:id | ${MANAGE} | catalog.item.archive | handler | -`,
  },
  fixtures: {
    'catalog.items.list': async () => ({ query: { limit: '5' } }),
    'catalog.items.by_barcode': async (s) => {
      const id = await seedItem(s, (await seedBranch(s)).id);
      const row = await s.h.db.selectFrom('items').select('barcode_key').where('id', '=', id).executeTakeFirstOrThrow();
      return { query: { barcode: row.barcode_key } };
    },
    'catalog.items.get': async (s) => ({ params: { id: await seedItem(s, (await seedBranch(s)).id) } }),
    'catalog.items.create': async (s) => ({
      params: { branchId: (await seedBranch(s)).id },
      body: { recordId: await seedRecord(s), barcode: barcode(), collectionTypeId: await umumId(s) },
    }),
    'catalog.items.batch': async (s) => ({
      params: { branchId: (await seedBranch(s)).id },
      body: { recordId: await seedRecord(s), count: 1, patternId: 'default', template: { collectionTypeId: await umumId(s) } },
    }),
    'catalog.items.bulk': async (s) => {
      const branchId = (await seedBranch(s)).id;
      return { params: { branchId }, body: { ids: [await seedItem(s, branchId)], set: { status: 'repair' } } };
    },
    'catalog.items.update': branchItem(() => ({ version: 0, note: 'Catatan matriks' })),
    'catalog.items.archive': branchItem(() => ({ version: 0 })),
  },
  maintenance: {},
};
