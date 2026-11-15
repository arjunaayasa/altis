import type { TxCtx } from '../../context.js';
import { lockLiveMember, memberNotFound, memberStale, memberValidationFailed, writeMemberEvents } from '../common.js';

// A member's photo: `members.photo_file_id` names a `files` row of the upload context `members.photo` (a JPEG the
// admin cropped in the browser to 300 × 400, at most 500 KB), owned by the member (`owner_type 'members'`) and
// served to staff only.
//
// - The upload must be one of that context that no one else owns; the claim re-checks the owner in its UPDATE, so two
//   members cannot claim one upload.
// - The photo it replaces (or that null removes) is deleted: its `files` row in this transaction, its stored content
//   after the commit (the caller removes the ids this answers), so a replaced photo leaves nothing behind.
// - History `photo`; audit `members.member.photo_set` (`meta.removed` when the photo was removed).

/** The upload context of member photos, and the owner type of a claimed one. */
export const MEMBER_PHOTO_CONTEXT = 'members.photo';
export const MEMBER_PHOTO_OWNER = 'members';

/**
 * Sets (or with null removes) the photo of the member `id`; `version` is the member's. Answers the new version and the
 * ids of the files whose stored content the caller deletes after the commit.
 *
 * @throws DomainError NOT_FOUND; CONFLICT_STALE; VALIDATION_FAILED at `fileId` (`not_found`, `invalid`)
 */
export async function setMemberPhoto(tx: TxCtx, id: string, fileId: string | null, version: number): Promise<{ id: string; version: number; deleteFiles: string[] }> {
  const { trx } = tx;
  if (!(await lockLiveMember(trx, id))) throw memberNotFound();
  const before = await trx.selectFrom('members').select(['photo_file_id', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
  if (Number(before.version) !== version) throw memberStale();

  if (fileId !== null && fileId !== before.photo_file_id) {
    const file = await trx.selectFrom('files').select(['context', 'owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirst();
    if (file === undefined) throw memberValidationFailed([{ path: 'fileId', code: 'not_found' }]);
    if (file.context !== MEMBER_PHOTO_CONTEXT || file.owner_type !== null || file.owner_id !== null) {
      throw memberValidationFailed([{ path: 'fileId', code: 'invalid' }]);
    }
    const claimed = await trx
      .updateTable('files')
      .set({ owner_type: MEMBER_PHOTO_OWNER, owner_id: id, access: 'staff' })
      .where('id', '=', fileId)
      .where('context', '=', MEMBER_PHOTO_CONTEXT)
      .where('owner_type', 'is', null)
      .where('owner_id', 'is', null)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) throw memberValidationFailed([{ path: 'fileId', code: 'invalid' }]);
  }
  const deleteFiles: string[] = [];
  if (before.photo_file_id !== null && before.photo_file_id !== fileId) {
    await trx.deleteFrom('files').where('id', '=', before.photo_file_id).execute();
    deleteFiles.push(before.photo_file_id);
  }
  const updated = await trx
    .updateTable('members')
    .set((eb) => ({ photo_file_id: fileId, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw memberStale();
  await writeMemberEvents(tx, id, [{ type: 'photo', meta: { removed: fileId === null } }]);
  await tx.audit({ action: 'members.member.photo_set', entity: 'members', entityId: id, meta: { removed: fileId === null } });
  return { id, version: version + 1, deleteFiles };
}

/**
 * Claims the uploads `fileIds` of `context` for the setting `settingKey` (`owner_type 'settings'`, `owner_id` the key),
 * and releases the files of that setting it no longer names (they lose their owner and are swept as orphan uploads).
 * An id that is not an unowned upload of that context, nor one the setting holds, is left as it is.
 */
export async function claimSettingsFiles(trx: TxCtx['trx'], settingKey: string, context: string, fileIds: readonly string[]): Promise<void> {
  const held = await trx.selectFrom('files').select('id').where('owner_type', '=', 'settings').where('owner_id', '=', settingKey).execute();
  const release = held.map((r) => r.id).filter((id) => !fileIds.includes(id));
  if (release.length > 0) await trx.updateTable('files').set({ owner_type: null, owner_id: null }).where('id', 'in', release).execute();
  if (fileIds.length > 0) {
    await trx
      .updateTable('files')
      .set({ owner_type: 'settings', owner_id: settingKey, access: 'staff' })
      .where('id', 'in', [...fileIds])
      .where('context', '=', context)
      .where('owner_type', 'is', null)
      .where('owner_id', 'is', null)
      .execute();
  }
}
