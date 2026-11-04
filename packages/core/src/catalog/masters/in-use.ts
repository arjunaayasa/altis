import type { TxCtx } from '../../context.js';
import { ID_BATCH, lockMasterRow, masterInUse, masterNotFound, masterStale, type Db, type MasterTable } from './support.js';

// How many live rows use a master (Phase 2 decision P2-16, Review Focus 2): a material type or a language is used by
// live records, a collection type or a supplier by live items. A master in use cannot be archived (409
// CATALOG_IN_USE with `meta.count`); the way out is to change those records or items first. A custom field is never in
// use in that sense (§3.7: it may always be archived, its values stay); its `usage` is the number of values it holds.
//
// "Live" is `archived_at IS NULL`: a merged record is archived, an archived (withdrawn) item has `archived_at`.
// `records (language_id, archived_at)`, `items (collection_type_id, archived_at)` and `items (supplier_id,
// archived_at)` are indexed (migration 0028, Task 39: the perf seed of K9 measured these counts reading the whole table
// on every list), so the counts of languages, collection types and suppliers read an index alone; they run on an
// archive and once per list of a master screen, never per record.

/** The masters whose usage can be counted: their table names (the audit `entity` of their actions). */
export type MasterKind = MasterTable;

/** Counts per id of `ids` (every id present, 0 when unused). */
async function countBy(db: Db, kind: MasterKind, ids: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const batch = unique.slice(i, i + ID_BATCH);
    let rows: { key: string | null; n: number | string | bigint }[];
    switch (kind) {
      case 'material_types':
        rows = await db
          .selectFrom('records')
          .select((eb) => [eb.ref('material_type_id').as('key'), eb.fn.countAll<number | string | bigint>().as('n')])
          .where('material_type_id', 'in', batch)
          .where('archived_at', 'is', null)
          .groupBy('material_type_id')
          .execute();
        break;
      case 'languages':
        rows = await db
          .selectFrom('records')
          .select((eb) => [eb.ref('language_id').as('key'), eb.fn.countAll<number | string | bigint>().as('n')])
          .where('language_id', 'in', batch)
          .where('archived_at', 'is', null)
          .groupBy('language_id')
          .execute();
        break;
      case 'collection_types':
        rows = await db
          .selectFrom('items')
          .select((eb) => [eb.ref('collection_type_id').as('key'), eb.fn.countAll<number | string | bigint>().as('n')])
          .where('collection_type_id', 'in', batch)
          .where('archived_at', 'is', null)
          .groupBy('collection_type_id')
          .execute();
        break;
      case 'suppliers':
        rows = await db
          .selectFrom('items')
          .select((eb) => [eb.ref('supplier_id').as('key'), eb.fn.countAll<number | string | bigint>().as('n')])
          .where('supplier_id', 'in', batch)
          .where('archived_at', 'is', null)
          .groupBy('supplier_id')
          .execute();
        break;
      case 'custom_field_defs':
        rows = await db
          .selectFrom('custom_values')
          .select((eb) => [eb.ref('field_id').as('key'), eb.fn.countAll<number | string | bigint>().as('n')])
          .where('field_id', 'in', batch)
          .groupBy('field_id')
          .execute();
        break;
    }
    for (const r of rows) if (r.key !== null) counts.set(r.key, Number(r.n));
  }
  return counts;
}

/**
 * How many live rows use the master `id` of `kind`: live records for `material_types` and `languages`, live items for
 * `collection_types` and `suppliers`, stored values for `custom_field_defs`. `db` is the handle's `db` or a transaction.
 */
export async function masterUsage(db: Db, kind: MasterKind, id: string): Promise<number> {
  return (await countBy(db, kind, [id])).get(id) ?? 0;
}

/** {@link masterUsage} of every id of `ids` at once (a list's `usage`). */
export function masterUsages(db: Db, kind: MasterKind, ids: readonly string[]): Promise<Map<string, number>> {
  return countBy(db, kind, ids);
}

/**
 * Archives the master `id` of `table` (`archived_at = now`, `version` + 1) and audits `catalog.master.archive` once
 * (`entity` = the table): the row is locked first, then its `version` compared, then (unless `o.inUseAllowed`) its usage
 * counted, so a master that live records or items use is refused. One already archived is answered as it is (a retried
 * DELETE), its entry saying `meta.alreadyArchived: true`, since an audited route writes exactly one entry.
 *
 * @returns the row's version after the call
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; CATALOG_IN_USE with `meta.count`
 */
export async function archiveMaster(
  tx: TxCtx,
  table: MasterTable,
  id: string,
  version: number,
  o: { inUseAllowed?: boolean } = {},
): Promise<{ version: number }> {
  const { trx } = tx;
  await lockMasterRow(trx, table, id);
  // Every master table has these columns; Kysely cannot narrow a union of table names.
  const before = await trx.selectFrom(table as 'languages').select(['archived_at', 'version']).where('id', '=', id).executeTakeFirst();
  if (before === undefined) throw masterNotFound(table);
  if (Number(before.version) !== version) throw masterStale(table);
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.master.archive', entity: table, entityId: id, meta: { alreadyArchived: true } });
    return { version };
  }
  if (o.inUseAllowed !== true) {
    const count = await masterUsage(trx, table, id);
    if (count > 0) throw masterInUse(table, count);
  }
  const updated = await trx
    .updateTable(table as 'languages')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw masterStale(table);
  await tx.audit({ action: 'catalog.master.archive', entity: table, entityId: id, meta: {} });
  return { version: version + 1 };
}
