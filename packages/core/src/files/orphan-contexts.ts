import type { UploadContextName } from '@altis/shared/api/files';

// The upload contexts whose unclaimed files a housekeeping job sweeps: an upload that no owner claimed within 24 hours
// is marked, its blob removed, then its row (the catalogue housekeeping's pattern). Each entry names the job that
// sweeps it: the catalogue housekeeping keeps the four catalogue contexts, the reports housekeeping takes the
// community contexts. Staged contexts are never listed: their uploads are not `files` rows, and the upload sessions
// clean their own staging. Append-only, one block per milestone.

/** One swept context and the job that sweeps it. */
export interface OrphanUploadContext {
  context: UploadContextName;
  sweptBy: 'catalog.housekeeping' | 'reports.housekeeping';
}

/** The swept contexts, in registry order. */
export const ORPHAN_UPLOAD_CONTEXTS: readonly OrphanUploadContext[] = Object.freeze([
  Object.freeze<OrphanUploadContext>({ context: 'catalog.cover', sweptBy: 'catalog.housekeeping' }),
  Object.freeze<OrphanUploadContext>({ context: 'catalog.attachment', sweptBy: 'catalog.housekeeping' }),
  Object.freeze<OrphanUploadContext>({ context: 'catalog.floor_plan', sweptBy: 'catalog.housekeeping' }),
  Object.freeze<OrphanUploadContext>({ context: 'opac.page_image', sweptBy: 'catalog.housekeeping' }),
  // ---- Komunitas K1 (uploads) ----
  // Evidence files and register attachments (training certificates, partnership and document files).
  Object.freeze<OrphanUploadContext>({ context: 'accreditation.evidence', sweptBy: 'reports.housekeeping' }),
  // ---- Komunitas K2 (members extended) ----
  // A member photo never claimed by a member, and card pictures no card profile names.
  Object.freeze<OrphanUploadContext>({ context: 'members.photo', sweptBy: 'reports.housekeeping' }),
  Object.freeze<OrphanUploadContext>({ context: 'members.card_asset', sweptBy: 'reports.housekeeping' }),
]);
