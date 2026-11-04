import type { TxCtx } from '../../context.js';
import { afterRecordWrite, lockRecordRows, mergedRecord, readRecordRow, recordStale, validationFailed } from './service.js';

// A record's cover (Phase 2 spec §3.1, §8): `records.cover_file_id` names a `files` row of the upload context
// `catalog.cover`. The admin shrinks the image in the browser and uploads it (Task 24); this claims the upload.
//
// - The file must be a `catalog.cover` upload that no one else owns (`{path: 'fileId', code: 'not_found' |
//   'invalid'}` otherwise). It then belongs to the record (`owner_type 'records'`, `owner_id`) and is public (§8).
// - The cover it replaces (or that null removes) loses its owner and turns `staff`, so `catalog.housekeeping` removes
//   it as an orphan upload (Task 18), and nobody fetches it meanwhile.
// - The claim re-checks the owner in its UPDATE: two records claiming the same upload at once cannot both win.
// - Audited as `catalog.record.update` with `meta.fields: ['cover']`; `changed_at` moves, the record is indexed and
//   `catalog.record.changed` published.

/**
 * Sets (or with null removes) the cover of `id`; `version` is the record's. Answers the new version.
 *
 * @throws DomainError NOT_FOUND; CATALOG_MERGE_INVALID for a merged record; CONFLICT_STALE; VALIDATION_FAILED at
 *   `fileId` (`not_found`, or `invalid` for a file of another context or another owner)
 */
export async function setCover(tx: TxCtx, id: string, fileId: string | null, version: number): Promise<{ version: number }> {
  const { trx } = tx;
  await lockRecordRows(trx, [id]);
  const before = await readRecordRow(trx, id);
  if (before.merged_into !== null) throw mergedRecord();
  if (Number(before.version) !== version) throw recordStale();

  if (fileId !== null) {
    const file = await trx.selectFrom('files').select(['context', 'owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirst();
    if (file === undefined) throw validationFailed([{ path: 'fileId', code: 'not_found' }]);
    const ownedHere = file.owner_type === 'records' && file.owner_id === id;
    const unowned = file.owner_type === null && file.owner_id === null;
    if (file.context !== 'catalog.cover' || !(ownedHere || unowned)) throw validationFailed([{ path: 'fileId', code: 'invalid' }]);
    const claimed = await trx
      .updateTable('files')
      .set({ owner_type: 'records', owner_id: id, access: 'public' })
      .where('id', '=', fileId)
      .where('context', '=', 'catalog.cover')
      .where((eb) => eb.or([eb.and([eb('owner_type', 'is', null), eb('owner_id', 'is', null)]), eb.and([eb('owner_type', '=', 'records'), eb('owner_id', '=', id)])]))
      .executeTakeFirst();
    // Claimed meanwhile by another record (an upload this record holds already may change nothing, and some drivers
    // count only changed rows).
    if (unowned && Number(claimed.numUpdatedRows) !== 1) throw validationFailed([{ path: 'fileId', code: 'invalid' }]);
  }
  if (before.cover_file_id !== null && before.cover_file_id !== fileId) {
    await trx
      .updateTable('files')
      .set({ owner_type: null, owner_id: null, access: 'staff' })
      .where('id', '=', before.cover_file_id)
      .where('owner_type', '=', 'records')
      .where('owner_id', '=', id)
      .execute();
  }
  const updated = await trx
    .updateTable('records')
    .set((eb) => ({ cover_file_id: fileId, changed_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw recordStale();
  await afterRecordWrite(tx, [id], { action: 'catalog.record.update', entity: 'records', entityId: id, meta: { fields: ['cover'] } });
  return { version: version + 1 };
}
