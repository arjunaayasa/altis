import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the bibliographic records (Phase 2 Task 16; the plan's route
// catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same
// order. Every route is `deny` in maintenance, so there is no maintenance entry.
//
// The fixtures seed what a call needs straight into the tables (a record, an upload's `files` row), each call its
// own, so that a super admin's call succeeds (audit once) whatever the personas before it did.

/** The id of the seeded material type BUKU (§2.6). */
async function bukuId(s: MatrixSeed): Promise<string> {
  return (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
}

/** A record of its own (version 0); archived when asked. */
async function seedRecord(s: MatrixSeed, o: { archived?: boolean } = {}): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: await bukuId(s),
      title: 'Cantuman Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman matriks',
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
      archived_at: o.archived === true ? s.now : null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** A completed `catalog.cover` upload nobody owns yet. */
async function seedCoverFile(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('files')
    .values({
      id,
      original_name: 'sampul.webp',
      mime: 'image/webp',
      size: 64,
      sha256: 'c'.repeat(64),
      context: 'catalog.cover',
      owner_type: null,
      owner_id: null,
      access: 'staff',
      status: 'ok',
      created_at: s.now,
      created_by: null,
    })
    .execute();
  return id;
}

const record = (o: { archived?: boolean } = {}): MatrixFixture => async (s) => ({ params: { id: await seedRecord(s, o) }, body: { version: 0 } });

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.records.list': 'GET /api/v1/catalog/records | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.records.get': 'GET /api/v1/catalog/records/:id | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.records.create':
      'POST /api/v1/catalog/records | P:catalog.records.manage | - | - | write | deny | store | catalog.record.create | handler | -',
    'catalog.records.update':
      'PATCH /api/v1/catalog/records/:id | P:catalog.records.manage | - | - | write | deny | store | catalog.record.update | handler | -',
    'catalog.records.archive':
      'DELETE /api/v1/catalog/records/:id | P:catalog.records.manage | - | - | write | deny | store | catalog.record.archive | handler | -',
    'catalog.records.restore':
      'POST /api/v1/catalog/records/:id/restore | P:catalog.records.manage | - | - | write | deny | store | catalog.record.restore | handler | -',
    'catalog.records.merge':
      'POST /api/v1/catalog/records/:id/merge | P:catalog.records.manage | - | - | write | deny | store | catalog.record.merge | handler | -',
    'catalog.records.cover':
      'PUT /api/v1/catalog/records/:id/cover | P:catalog.records.manage | - | - | write | deny | store | catalog.record.update | handler | -',
    'catalog.records.duplicates':
      'POST /api/v1/catalog/records/duplicates | P:catalog.records.manage | - | - | read | deny | none | null | handler | -',
  },
  fixtures: {
    'catalog.records.list': async () => ({ query: { limit: '5', sort: 'title' } }),
    'catalog.records.get': async (s) => ({ params: { id: await seedRecord(s) } }),
    'catalog.records.create': async (s) => ({
      body: {
        materialTypeId: await bukuId(s),
        title: 'Cantuman Baru Matriks',
        agents: [{ ref: { type: 'person', name: 'Penulis, Matriks' }, role: 'aut', isMain: true }],
      },
    }),
    'catalog.records.update': async (s) => ({ params: { id: await seedRecord(s) }, body: { version: 0, edition: 'Cet. 2' } }),
    'catalog.records.archive': record(),
    'catalog.records.restore': record({ archived: true }),
    'catalog.records.merge': async (s) => ({ params: { id: await seedRecord(s) }, body: { sourceId: await seedRecord(s), version: 0 } }),
    'catalog.records.cover': async (s) => ({ params: { id: await seedRecord(s) }, body: { fileId: await seedCoverFile(s), version: 0 } }),
    'catalog.records.duplicates': async () => ({ body: { title: 'Cantuman Matriks', identifiers: [{ type: 'isbn', value: '978-602-03-0112-9' }] } }),
  },
  maintenance: {},
};
