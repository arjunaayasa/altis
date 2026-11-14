import type { DB } from '@altis/db';
import type { Transaction } from 'kysely';
import { validationFailed } from './common.js';

// The files of the registers and of the evidence (spec §5.6, §10.6): every one is an upload of the context
// `accreditation.evidence` (PDF, or JPEG converted in the browser), claimed by the row that uses it. The claiming row is
// its owner: `owner_type` = the table name (`accred_evidence` for an evidence row, `staff_trainings` for a certificate,
// `library_partnerships` for an agreement, `library_documents` for a document), `owner_id` = the row's id.
//
// - Only a completed upload (its `files` row exists and is `ok`) of that context that nobody owns yet can be claimed;
//   anything else (an unknown id, another context, a file owned already) is the field error `not_found` at the body
//   field that named it.
// - The claim is one conditional UPDATE that repeats the "nobody owns it" test: two rows claiming the same upload at
//   once cannot both win.
// - A file that a row stops using (replaced, removed, or its evidence row deleted) is released: its owner is cleared,
//   so the report housekeeping removes it as an orphan upload after 24 hours, and the evidence access rule keeps it
//   from anyone without the workspace permission meanwhile.

/** The upload context of every register file and evidence file. */
export const ACCRED_UPLOAD_CONTEXT = 'accreditation.evidence';

/** Who may own an accreditation file. */
export type AccredFileOwner = 'accred_evidence' | 'staff_trainings' | 'library_partnerships' | 'library_documents';

/** The body field that names each owner's upload: the path of its field error. */
const UPLOAD_FIELD: Readonly<Record<AccredFileOwner, string>> = Object.freeze({
  accred_evidence: 'uploadId',
  staff_trainings: 'certificateUploadId',
  library_partnerships: 'documentUploadId',
  library_documents: 'fileUploadId',
});

/** A claimed file: its id (the upload's), size in bytes, original name and MIME type. */
export interface ClaimedUpload {
  fileId: string;
  size: number;
  name: string;
  mime: string;
}

/**
 * Claims the completed `accreditation.evidence` upload `uploadId` for the row `o.ownerId` of `o.ownerType`.
 *
 * @throws DomainError VALIDATION_FAILED `{path: <the body field of the owner's upload>, code: 'not_found'}` for an
 *   unknown upload, one of another context, one not completed, or one owned already
 */
export async function claimUpload(trx: Transaction<DB>, uploadId: string, o: { ownerType: AccredFileOwner; ownerId: string }): Promise<ClaimedUpload> {
  const claimed = await trx
    .updateTable('files')
    .set({ owner_type: o.ownerType, owner_id: o.ownerId })
    .where('id', '=', uploadId)
    .where('context', '=', ACCRED_UPLOAD_CONTEXT)
    .where('status', '=', 'ok')
    .where('owner_type', 'is', null)
    .where('owner_id', 'is', null)
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) !== 1) throw validationFailed([{ path: UPLOAD_FIELD[o.ownerType], code: 'not_found' }]);
  const row = await trx.selectFrom('files').select(['id', 'size', 'original_name', 'mime']).where('id', '=', uploadId).executeTakeFirstOrThrow();
  return { fileId: row.id, size: Number(row.size), name: row.original_name, mime: row.mime };
}

/** Releases the file `fileId` when the row `o.ownerId` of `o.ownerType` still owns it (its owner is cleared). */
export async function releaseUpload(trx: Transaction<DB>, fileId: string, o: { ownerType: AccredFileOwner; ownerId: string }): Promise<void> {
  await trx
    .updateTable('files')
    .set({ owner_type: null, owner_id: null })
    .where('id', '=', fileId)
    .where('owner_type', '=', o.ownerType)
    .where('owner_id', '=', o.ownerId)
    .execute();
}

/**
 * The file a row holds after a write that may change it: `next` undefined keeps `current` (answers undefined: nothing
 * to store), the same id keeps it, null releases `current`, another upload id is claimed and `current` released.
 *
 * @throws DomainError VALIDATION_FAILED `not_found` at the owner's upload field (see {@link claimUpload})
 */
export async function replaceUpload(
  trx: Transaction<DB>,
  current: string | null,
  next: string | null | undefined,
  o: { ownerType: AccredFileOwner; ownerId: string },
): Promise<string | null | undefined> {
  if (next === undefined || next === current) return undefined;
  const fileId = next === null ? null : (await claimUpload(trx, next, o)).fileId;
  if (current !== null) await releaseUpload(trx, current, o);
  return fileId;
}
