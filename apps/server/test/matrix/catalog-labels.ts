import { newId, normalizeKey } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the label PDF (Phase 2 Task 36; the plan's route catalog):
// `POST catalog/labels` needs `catalog.records.read`, is a read-only POST (`mode: read`, `idempotency: none`, no audit)
// and runs `tx: 'self'`, so no transaction is held open while the PDF is built. It is `deny` in maintenance, so there is
// no maintenance entry.
//
// The fixture seeds a branch, a record and one item of its own straight into the tables and asks for that item's label
// on the seeded spine profile. Only types come from matrix-fixtures.ts: it imports this file through matrix/catalog.ts
// (see there).

/** A live item of a record and a branch of its own; its id. */
async function seedLabelItem(s: MatrixSeed): Promise<string> {
  const branchId = newId();
  const code = `ML${branchId.slice(-12)}`;
  await s.h.db
    .insertInto('branches')
    .values({ id: branchId, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  const buku = (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const umum = (await s.h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
  const recordId = newId();
  await s.h.db
    .insertInto('records')
    .values({
      id: recordId,
      material_type_id: buku,
      title: 'Cantuman Label Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman label matriks',
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: '899.221 MAT c',
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
  const id = newId();
  const barcode = `ML-${id.slice(-12)}`;
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
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.labels.create': 'POST /api/v1/catalog/labels | P:catalog.records.read | - | - | read | deny | none | null | self | -',
  },
  fixtures: {
    'catalog.labels.create': async (s) => ({ body: { profileId: 'spine-a4', itemIds: [await seedLabelItem(s)], startPosition: 1, copies: 1 } }),
  },
  maintenance: {},
};
