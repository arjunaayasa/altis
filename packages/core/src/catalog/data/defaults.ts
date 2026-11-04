import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';

// The default material type and collection type (Phase 2 spec §2.6, §5.3 `defaultMaterialTypeId` /
// `defaultCollectionTypeId`): what a record or item gets when its source names none (a CSV row without
// `material_type`, a MARC record whose leader matches nothing, an import's batch of items). The configured one when it
// is live, else the seed (`BUKU`, `UMUM`) when live, else the live one first by sort order.

type Db = Kysely<DB> | Transaction<DB>;

/** The master tables with a default. */
type MasterTable = 'material_types' | 'collection_types';

async function defaultOf(db: Db, table: MasterTable, configured: string | null, seedCode: string, path: string): Promise<string> {
  // Both tables share these columns; Kysely cannot narrow a union of table names.
  const t = table as 'material_types';
  if (configured !== null) {
    const row = await db.selectFrom(t).select('id').where('id', '=', configured).where('archived_at', 'is', null).executeTakeFirst();
    if (row !== undefined) return row.id;
  }
  const seed = await db.selectFrom(t).select('id').where('code_key', '=', seedCode).where('archived_at', 'is', null).executeTakeFirst();
  if (seed !== undefined) return seed.id;
  const first = await db
    .selectFrom(t)
    .select('id')
    .where('archived_at', 'is', null)
    .orderBy('sort_order')
    .orderBy('code_key')
    .limit(1)
    .executeTakeFirst();
  if (first !== undefined) return first.id;
  throw new DomainError('VALIDATION_FAILED', {
    detail: `Tidak ada data induk ${table} yang aktif / There is no live row of ${table}`,
    meta: { errors: [{ path, code: 'not_found' }] },
  });
}

/**
 * The material type to use when none is given: `configured` when it names a live one, else `BUKU`, else the live one
 * with the lowest `sort_order`.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'materialTypeId', code: 'not_found'}` when no material type is live
 */
export function defaultMaterialTypeId(db: Db, configured: string | null): Promise<string> {
  return defaultOf(db, 'material_types', configured, 'BUKU', 'materialTypeId');
}

/**
 * The collection type to use when none is given: `configured` when it names a live one, else `UMUM`, else the live one
 * with the lowest `sort_order`.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'collectionTypeId', code: 'not_found'}` when no collection type is live
 */
export function defaultCollectionTypeId(db: Db, configured: string | null): Promise<string> {
  return defaultOf(db, 'collection_types', configured, 'UMUM', 'collectionTypeId');
}
