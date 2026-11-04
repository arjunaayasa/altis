import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the masters (Phase 2 Task 12; the plan's route catalog):
// material types, languages, collection types, suppliers and custom fields, four routes each, one row per route id in
// the row format of db/matrix.test.ts's CATALOG and one fixture per route in the same order. Every route is `deny` in
// maintenance, so there is no maintenance entry.
//
// Each call gets its own row (seeded straight into the table at version 0, used by nothing) and a code of its own, so
// that a super admin's call succeeds (audit once) whatever the personas before it did.

/** A code no other call uses (at most 32 characters, as the contract allows). */
const uniqueCode = (prefix: string): string => `${prefix}${newId().slice(-12)}`;

/** The trail and archive columns of a seeded master row. */
const trail = (s: MatrixSeed) => ({ archived_at: null, created_at: s.now, created_by: null, updated_at: s.now, updated_by: null });

async function seedMaterialType(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = uniqueCode('MX');
  await s.h.db
    .insertInto('material_types')
    .values({ id, code_display: code, code_key: normalizeKey(code), name_id: 'Jenis Matriks', name_en: 'Matrix type', marc_type: 'a', template: '{"fields":{},"defaults":{},"customFields":[]}', ...trail(s) })
    .execute();
  return id;
}

async function seedLanguage(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = uniqueCode('mx');
  await s.h.db.insertInto('languages').values({ id, code_display: code, code_key: normalizeKey(code), name_id: 'Bahasa Matriks', name_en: 'Matrix language', ...trail(s) }).execute();
  return id;
}

async function seedCollectionType(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = uniqueCode('MX');
  await s.h.db
    .insertInto('collection_types')
    .values({ id, code_display: code, code_key: normalizeKey(code), name_id: 'Koleksi Matriks', name_en: 'Matrix collection', ...trail(s) })
    .execute();
  return id;
}

async function seedSupplier(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = uniqueCode('MX');
  await s.h.db
    .insertInto('suppliers')
    .values({ id, code_display: code, code_key: normalizeKey(code), name: 'Pemasok Matriks', contact_name: null, phone: null, email: null, address: null, note: null, ...trail(s) })
    .execute();
  return id;
}

async function seedCustomField(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = uniqueCode('mx_');
  await s.h.db
    .insertInto('custom_field_defs')
    .values({ id, entity: 'records', code_key: normalizeKey(code), code_display: code, label: 'Ruas Matriks', label_en: null, type: 'text', options: null, ...trail(s) })
    .execute();
  return id;
}

/** PATCH `:id` of a row of its own (version 0) with `body`. */
const patch =
  (seed: (s: MatrixSeed) => Promise<string>, body: Record<string, unknown>): MatrixFixture =>
  async (s) => ({ params: { id: await seed(s) }, body: { version: 0, ...body } });

/** DELETE `:id` of an unused row of its own (version 0). */
const archive =
  (seed: (s: MatrixSeed) => Promise<string>): MatrixFixture =>
  async (s) => ({ params: { id: await seed(s) }, body: { version: 0 } });

const list: MatrixFixture = async () => ({ query: { includeArchived: 'false' } });

const READ = 'P:catalog.records.read | - | - | read | deny | none | null | - | -';
const write = (action: string): string => `P:catalog.masters.manage | - | - | write | deny | store | catalog.master.${action} | handler | -`;

/** The four rows of the master `key` under `catalog/<path>`. */
function rows(key: string, path: string): Record<string, string> {
  const base = `/api/v1/catalog/${path}`;
  return {
    [`catalog.${key}.list`]: `GET ${base} | ${READ}`,
    [`catalog.${key}.create`]: `POST ${base} | ${write('create')}`,
    [`catalog.${key}.update`]: `PATCH ${base}/:id | ${write('update')}`,
    [`catalog.${key}.archive`]: `DELETE ${base}/:id | ${write('archive')}`,
  };
}

export const MATRIX: AreaMatrix = {
  rows: {
    ...rows('material_types', 'material-types'),
    ...rows('languages', 'languages'),
    ...rows('collection_types', 'collection-types'),
    ...rows('suppliers', 'suppliers'),
    ...rows('custom_fields', 'custom-fields'),
  },
  fixtures: {
    'catalog.material_types.list': list,
    'catalog.material_types.create': async () => ({
      body: {
        code: uniqueCode('MB'),
        nameId: 'Jenis Baru Matriks',
        nameEn: 'New matrix type',
        marcType: 'a',
        marcLevel: 'm',
        contentType: 'txt',
        mediaType: 'n',
        carrierType: 'nc',
        schemaType: 'Book',
        dcmiType: 'Text',
        template: { fields: { subtitle: 'required' }, defaults: {}, customFields: [] },
        sortOrder: 100,
      },
    }),
    'catalog.material_types.update': patch(seedMaterialType, { nameId: 'Jenis Matriks Diubah' }),
    'catalog.material_types.archive': archive(seedMaterialType),

    'catalog.languages.list': list,
    'catalog.languages.create': async () => ({ body: { code: uniqueCode('mb'), nameId: 'Bahasa Baru Matriks', nameEn: 'New matrix language' } }),
    'catalog.languages.update': patch(seedLanguage, { nameEn: 'Matrix language (changed)' }),
    'catalog.languages.archive': archive(seedLanguage),

    'catalog.collection_types.list': list,
    'catalog.collection_types.create': async () => ({
      body: { code: uniqueCode('MB'), nameId: 'Koleksi Baru Matriks', nameEn: 'New matrix collection', loanable: true, selfService: false, sortOrder: 100 },
    }),
    'catalog.collection_types.update': patch(seedCollectionType, { loanable: false }),
    'catalog.collection_types.archive': archive(seedCollectionType),

    'catalog.suppliers.list': list,
    'catalog.suppliers.create': async () => ({ body: { code: uniqueCode('MB'), name: 'Pemasok Baru Matriks', email: 'pemasok@example.test' } }),
    'catalog.suppliers.update': patch(seedSupplier, { phone: '0274-123456' }),
    'catalog.suppliers.archive': archive(seedSupplier),

    'catalog.custom_fields.list': async () => ({ query: { entity: 'records' } }),
    'catalog.custom_fields.create': async () => ({
      body: {
        entity: 'items',
        type: 'select',
        code: uniqueCode('mb_'),
        labelId: 'Ruas Baru Matriks',
        options: [{ value: 'a', labelId: 'Pilihan A' }],
        required: false,
        sortOrder: 0,
        isPublic: false,
        isSearchable: false,
      },
    }),
    'catalog.custom_fields.update': patch(seedCustomField, { labelEn: 'Matrix field' }),
    'catalog.custom_fields.archive': archive(seedCustomField),
  },
  maintenance: {},
};
