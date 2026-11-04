import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the attachments (Phase 2 Task 18; the plan's route catalog,
// plus the panel's list `catalog.attachments.list`, see api/catalog/attachments.ts): one row per route id in the row
// format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is `deny` in
// maintenance, so there is no maintenance entry.
//
// The fixtures seed what a call needs straight into the tables (a record, an attachment), each call its own, so that
// a super admin's call succeeds (audit once) whatever the personas before it did.

/** The id of the seeded material type BUKU (§2.6). */
async function bukuId(s: MatrixSeed): Promise<string> {
  return (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
}

/** A record of its own (version 0). */
async function seedRecord(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: await bukuId(s),
      title: 'Cantuman Lampiran Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman lampiran matriks',
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

/** A link attachment (version 0) of a record of its own. */
async function seedAttachment(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('attachments')
    .values({
      id,
      record_id: await seedRecord(s),
      kind: 'url',
      file_id: null,
      url: 'https://repositori.example/matriks.pdf',
      title: 'Lampiran Matriks',
      description: null,
      access: 'public',
      legacy_access_limit: null,
      read_count: 0,
      sort_order: 0,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

const attachment = (body: Record<string, unknown>): MatrixFixture => async (s) => ({ params: { id: await seedAttachment(s) }, body });

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.attachments.list': 'GET /api/v1/catalog/records/:id/attachments | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.attachments.create':
      'POST /api/v1/catalog/records/:id/attachments | P:catalog.records.manage | - | - | write | deny | store | catalog.attachment.create | handler | -',
    'catalog.attachments.update':
      'PATCH /api/v1/catalog/attachments/:id | P:catalog.records.manage | - | - | write | deny | store | catalog.attachment.update | handler | -',
    'catalog.attachments.archive':
      'DELETE /api/v1/catalog/attachments/:id | P:catalog.records.manage | - | - | write | deny | store | catalog.attachment.archive | handler | -',
  },
  fixtures: {
    'catalog.attachments.list': async (s) => ({ params: { id: await seedRecord(s) } }),
    'catalog.attachments.create': async (s) => ({
      params: { id: await seedRecord(s) },
      body: { kind: 'url', url: 'https://repositori.example/bab-1.pdf', title: 'Bab 1', access: 'public' },
    }),
    'catalog.attachments.update': attachment({ version: 0, title: 'Lampiran Matriks (revisi)', access: 'staff' }),
    'catalog.attachments.archive': attachment({ version: 0 }),
  },
  maintenance: {},
};
