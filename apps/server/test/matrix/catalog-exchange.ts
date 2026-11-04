import { createHash } from 'node:crypto';
import { acceptChunk, completeUpload, createUpload, uploadContext, uploadOwner } from '@altis/core';
import { withTx } from '@altis/db';
import { newId, normalizeKey, systemRolePermissions } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of imports, exports and the MARC of one record (Phase 2 Task 31;
// the plan's route catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per
// route in the same order. Every route is `deny` in maintenance, so there is no maintenance entry; `catalog.exports.create`
// is `mode: system` (an edition never locks data, §1.3).
//
// The import is a dry run of a small `csv-records` file the caller uploaded (staged in the app's DATA_DIR) when the
// caller may import, so a super admin's call succeeds (audit once); any other caller names an upload nobody has (404
// after the gate). The export names no record (an empty `csv-records` export); the MARC is of a record seeded here.

const CSV = '\uFEFFtitle;year\r\nMatriks Impor;2026\r\n';

/** A completed `catalog.import` upload of `userId` holding {@link CSV}; its id. */
async function stagedCsv(s: MatrixSeed, userId: string): Promise<string> {
  if (s.dataDir === undefined) throw new Error('the catalog exchange fixtures need the DATA_DIR of the app');
  const dataDir = s.dataDir;
  const bytes = Buffer.from(CSV, 'utf8');
  const owner = uploadOwner(userId);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const context = uploadContext('catalog.import')!;
  const { id } = await withTx(s.h, (trx) => createUpload(trx, { owner, context, size: bytes.byteLength, sha256, now: s.now, dataDir }));
  await acceptChunk(s.h, { id, owner, n: 0, data: bytes, now: s.now, dataDir });
  await completeUpload(s.h, { id, owner, originalName: 'matriks.csv', now: s.now, dataDir });
  return id;
}

/** A record of the seeded material type BUKU; its id. */
async function seedMarcRecord(s: MatrixSeed): Promise<string> {
  const buku = await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', normalizeKey('BUKU')).executeTakeFirstOrThrow();
  const id = newId();
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: buku.id,
      title: 'Cantuman MARC Matriks',
      subtitle: null,
      responsibility: null,
      title_key: 'cantuman marc matriks',
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: '2026',
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

/**
 * Whether the caller holds `catalog.import.run` with a full session (matrix-fixtures.ts's `holds`, written out: an area
 * file imports no value from that module, whose top level reads this area's merge).
 */
function mayImport(s: MatrixSeed): boolean {
  if (s.user === null) return false;
  if (s.persona === 'super_admin' || s.persona === 'admin') return systemRolePermissions(s.persona).includes('catalog.import.run');
  return s.persona === 'perm:catalog.import.run';
}

const importFixture: MatrixFixture = async (s) => ({
  body: {
    uploadId: mayImport(s) ? await stagedCsv(s, s.user!.id) : newId(),
    matchOn: 'none',
    onMatch: 'skip',
    onDuplicate: 'report',
    createItems: false,
    dryRun: true,
  },
});

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.imports.create':
      'POST /api/v1/catalog/imports | P:catalog.import.run | - | - | write | deny | store | catalog.import.start | handler | -',
    'catalog.exports.create':
      'POST /api/v1/catalog/exports | P:catalog.export.run | - | - | system | deny | store | catalog.export.start | handler | -',
    'catalog.records.marc': 'GET /api/v1/catalog/records/:id/marc | P:catalog.records.read | - | - | read | deny | none | null | - | -',
  },
  fixtures: {
    'catalog.imports.create': importFixture,
    'catalog.exports.create': async () => ({ body: { format: 'csv-records', filter: { recordIds: [newId()] } } }),
    'catalog.records.marc': async (s) => ({ params: { id: await seedMarcRecord(s) }, query: { format: 'json' } }),
  },
  maintenance: {},
};
