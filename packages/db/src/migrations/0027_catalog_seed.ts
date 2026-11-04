import { isDomainError, newId } from '@altis/shared';
import type { Kysely } from 'kysely';
import type { AltisMigration } from '../migrator.js';

// 0027: the seed data of Phase 2 spec §2.6, inserted row by row only when its `code_key` is absent, so a library's
// own edits (names, archiving, sort order) are never touched and a rerun changes nothing:
//
// - 8 material types with their MARC leader/06–07, schema.org type, RDA 336/337/338 codes and DCMI type;
// - 16 languages by their MARC code (≈ ISO 639-2/B; `code_key` upper case as normalizeKey makes it);
// - 4 collection types: `REF` cannot be borrowed at a self-service kiosk, `TANDON` (the reserve) cannot be borrowed.
// No location is seeded (an item may have none). `created_by` is null (the system), every template empty (§3.8).
// The rows are literals (R44): the tables as this migration knows them, not the live `DB` type.

/** The seeded tables, as this migration knows them (a migration runs against the schema of its moment). */
type SeedTables = {
  material_types: {
    id: string;
    code_display: string;
    code_key: string;
    name_id: string;
    name_en: string;
    marc_type: string;
    marc_level: string;
    content_type: string;
    media_type: string;
    carrier_type: string;
    schema_type: string;
    dcmi_type: string;
    template: string;
    sort_order: number;
    archived_at: number | null;
    version: number;
    created_at: number;
    created_by: string | null;
    updated_at: number;
    updated_by: string | null;
  };
  languages: {
    id: string;
    code_display: string;
    code_key: string;
    name_id: string;
    name_en: string;
    archived_at: number | null;
    version: number;
    created_at: number;
    created_by: string | null;
    updated_at: number;
    updated_by: string | null;
  };
  collection_types: {
    id: string;
    code_display: string;
    code_key: string;
    name_id: string;
    name_en: string;
    loanable: number;
    self_service: number;
    sort_order: number;
    archived_at: number | null;
    version: number;
    created_at: number;
    created_by: string | null;
    updated_at: number;
    updated_by: string | null;
  };
};

type SeedTable = keyof SeedTables;

const EMPTY_TEMPLATE = '{"fields":{},"defaults":{},"customFields":[]}';

/** code, name (id), name (en), leader/06, leader/07, schema.org, RDA content/media/carrier, DCMI. */
const MATERIAL_TYPES: readonly (readonly [string, string, string, string, string, string, string, string, string, string])[] = [
  ['BUKU', 'Buku', 'Book', 'a', 'm', 'Book', 'txt', 'n', 'nc', 'Text'],
  ['EBOOK', 'Buku elektronik', 'E-book', 'a', 'm', 'Book', 'txt', 'c', 'cr', 'Text'],
  ['KARYA-ILMIAH', 'Karya ilmiah', 'Academic work', 'a', 'm', 'Thesis', 'txt', 'n', 'nc', 'Text'],
  ['BERSERI', 'Terbitan berseri', 'Serial', 'a', 's', 'Periodical', 'txt', 'n', 'nc', 'Text'],
  ['PETA', 'Peta', 'Map', 'e', 'm', 'Map', 'cri', 'n', 'nb', 'Image'],
  ['AUDIO', 'Rekaman suara', 'Sound recording', 'i', 'm', 'AudioObject', 'spw', 's', 'sd', 'Sound'],
  ['VIDEO', 'Video', 'Video', 'g', 'm', 'VideoObject', 'tdi', 'v', 'vd', 'MovingImage'],
  ['CAMPURAN', 'Bahan campuran', 'Mixed materials', 'o', 'm', 'CreativeWork', 'xxx', 'n', 'nz', 'Collection'],
];

/** MARC code (display), name (id), name (en). */
const LANGUAGES: readonly (readonly [string, string, string])[] = [
  ['ind', 'Indonesia', 'Indonesian'],
  ['eng', 'Inggris', 'English'],
  ['ara', 'Arab', 'Arabic'],
  ['jav', 'Jawa', 'Javanese'],
  ['sun', 'Sunda', 'Sundanese'],
  ['may', 'Melayu', 'Malay'],
  ['min', 'Minangkabau', 'Minangkabau'],
  ['ban', 'Bali', 'Balinese'],
  ['bug', 'Bugis', 'Buginese'],
  ['mad', 'Madura', 'Madurese'],
  ['chi', 'Tionghoa', 'Chinese'],
  ['jpn', 'Jepang', 'Japanese'],
  ['kor', 'Korea', 'Korean'],
  ['dut', 'Belanda', 'Dutch'],
  ['ger', 'Jerman', 'German'],
  ['fre', 'Prancis', 'French'],
];

/** code, name (id), name (en), loanable, self-service. */
const COLLECTION_TYPES: readonly (readonly [string, string, string, number, number])[] = [
  ['UMUM', 'Umum', 'General', 1, 1],
  ['REF', 'Referensi', 'Reference', 1, 0],
  ['FIKSI', 'Fiksi', 'Fiction', 1, 1],
  ['TANDON', 'Tandon', 'Reserve', 0, 1],
];

/**
 * Inserts `row` unless a row with its `code_key` is there. A duplicate insert (another connection seeded it in
 * between, UNIQUE_VIOLATION) counts as seeded once the row can be read back; inside a transaction (PostgreSQL runs the
 * migrations in one) the error stands, since PostgreSQL has aborted the transaction anyway (the migration lock makes
 * that case unreachable).
 */
async function seedRow<T extends SeedTable>(db: Kysely<SeedTables>, table: T, row: SeedTables[T]): Promise<void> {
  // The three tables share `id` and `code_key`; Kysely cannot narrow a generic table name, so they are written as one.
  const shared = db as unknown as Kysely<Record<SeedTable, { id: string; code_key: string }>>;
  const present = async () =>
    (await shared.selectFrom(table as SeedTable).select('id').where('code_key', '=', row.code_key).executeTakeFirst()) !== undefined;
  if (await present()) return;
  try {
    await shared.insertInto(table as SeedTable).values(row as { id: string; code_key: string }).execute();
  } catch (error) {
    if (db.isTransaction || !isDomainError(error) || error.code !== 'UNIQUE_VIOLATION' || !(await present())) throw error;
  }
}

export const catalogSeed: AltisMigration = {
  async up(db) {
    const seed = db as Kysely<SeedTables>;
    const now = Date.now();
    const trail = { archived_at: null, version: 0, created_at: now, created_by: null, updated_at: now, updated_by: null };
    for (const [i, [code, nameId, nameEn, marcType, marcLevel, schemaType, content, media, carrier, dcmi]] of MATERIAL_TYPES.entries()) {
      await seedRow(seed, 'material_types', {
        id: newId(now),
        code_display: code,
        code_key: code,
        name_id: nameId,
        name_en: nameEn,
        marc_type: marcType,
        marc_level: marcLevel,
        content_type: content,
        media_type: media,
        carrier_type: carrier,
        schema_type: schemaType,
        dcmi_type: dcmi,
        template: EMPTY_TEMPLATE,
        sort_order: (i + 1) * 10,
        ...trail,
      });
    }
    for (const [code, nameId, nameEn] of LANGUAGES) {
      await seedRow(seed, 'languages', {
        id: newId(now),
        code_display: code,
        code_key: code.toUpperCase(),
        name_id: nameId,
        name_en: nameEn,
        ...trail,
      });
    }
    for (const [i, [code, nameId, nameEn, loanable, selfService]] of COLLECTION_TYPES.entries()) {
      await seedRow(seed, 'collection_types', {
        id: newId(now),
        code_display: code,
        code_key: code,
        name_id: nameId,
        name_en: nameEn,
        loanable,
        self_service: selfService,
        sort_order: (i + 1) * 10,
        ...trail,
      });
    }
  },
};
