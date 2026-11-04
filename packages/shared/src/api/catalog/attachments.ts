/**
 * The attachments API vocabulary (Phase 2 spec §8, §12.2; plan Task 18): a record's files and links.
 *
 * `attachments.access` and `files.access` are kept equal by the service in the same transaction; a file of a hidden,
 * archived or merged record is served as a staff file. The `store` routes answer `StoreResponse` (S15).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/attachments`.
 */
import { z } from 'zod';
import { ATTACHMENT_ACCESS, type AttachmentAccess, type AttachmentKind } from '../../catalog-vocab.js';
import { ulidField, versionField } from '../common.js';
import { httpUrlField, longText, shortText, sortOrderField } from './common.js';

const attachmentCommon = {
  title: shortText(191).min(1),
  description: longText.nullable().optional(),
  access: z.enum(ATTACHMENT_ACCESS),
};

/**
 * `POST catalog/records/:id/attachments`: a stored file (`kind: 'file'`, a completed `catalog.attachment` upload with
 * no owner yet) or a link (`kind: 'url'`, http or https only, else `{path: 'url', code: 'invalid_url'}`). A file
 * attachment takes no `url` and a link no `fileId`.
 */
export const AttachmentCreateBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), fileId: ulidField, ...attachmentCommon }),
  z.strictObject({ kind: z.literal('url'), url: httpUrlField(), ...attachmentCommon }),
]);

export type AttachmentCreateBody = z.infer<typeof AttachmentCreateBody>;

/** `PATCH catalog/attachments/:id`: only the fields sent change; the kind, the file and the link stay. */
export const AttachmentPatchBody = z.strictObject({
  version: versionField,
  title: shortText(191).min(1).optional(),
  description: longText.nullable().optional(),
  access: z.enum(ATTACHMENT_ACCESS).optional(),
  sortOrder: sortOrderField.optional(),
});

export type AttachmentPatchBody = z.infer<typeof AttachmentPatchBody>;

/** One attachment as the admin sees it. `mime` and `size` are the file's (null for a link). */
export interface AttachmentView {
  id: string;
  recordId: string;
  kind: AttachmentKind;
  fileId: string | null;
  url: string | null;
  title: string;
  description: string | null;
  access: AttachmentAccess;
  mime: string | null;
  size: number | null;
  /** How often the OPAC viewer was opened (§8, best effort). */
  readCount: number;
  sortOrder: number;
  version: number;
}

/** The attachments of a record, in `sort_order`. */
export interface AttachmentListResponse {
  items: AttachmentView[];
}
