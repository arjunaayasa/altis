import type { TxCtx } from '../../context.js';
import { authorityNotFound, authorityStale, inUse, lockAuthorityRows, type AuthorityTable } from './common.js';
import { usageOf } from './usage.js';

// Archiving one authority (`DELETE catalog/{agents|subjects|publishers}/:id`; Phase 2 spec §3.5, plan Task 13).
//
// - One that live records still link to is refused: 409 CATALOG_IN_USE with `meta.count` (the way out is a merge).
//   Its thesaurus relations do not count: a subject that only stands in the thesaurus may be archived.
// - One already archived (a merged one too) is answered as it is, its entry saying `meta.alreadyArchived`, so a
//   retried request is harmless and the route still audits exactly once.
// - There is no restore route: an archived authority that was not merged comes back when a record names it (Task 1's
//   resolve*), or when the same key is created again (createAgent and the others).

/**
 * Archives the authority `id` of `kind` (`archived_at = now`, version + 1) and audits `catalog.authority.archive`
 * (entity = `kind`). Answers its new version.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE when `version` is not the row's; CATALOG_IN_USE (409, `meta.count`)
 */
export async function archiveAuthority(tx: TxCtx, kind: AuthorityTable, id: string, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  await lockAuthorityRows(trx, kind, [id]);
  // The three tables share these columns; Kysely cannot narrow a union of table names.
  const before = await trx
    .selectFrom(kind as 'agents')
    .select(['archived_at', 'version'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (before === undefined) throw authorityNotFound(kind);
  if (Number(before.version) !== version) throw authorityStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.authority.archive', entity: kind, entityId: id, meta: { alreadyArchived: true } });
    return { version };
  }
  const count = await usageOf(trx, kind, id);
  if (count > 0) throw inUse(count);
  const updated = await trx
    .updateTable(kind as 'agents')
    .set((eb) => ({ archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw authorityStale();
  await tx.audit({ action: 'catalog.authority.archive', entity: kind, entityId: id, meta: {} });
  return { version: version + 1 };
}
