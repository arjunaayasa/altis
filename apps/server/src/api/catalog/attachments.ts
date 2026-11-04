import { archiveAttachment, createAttachment, listAttachments, updateAttachment } from '@altis/core';
import { AttachmentCreateBody, AttachmentPatchBody, type AttachmentListResponse } from '@altis/shared/api/catalog/attachments';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField, versionField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { RouteDecl } from '../../http/route.js';
import { route } from '../../http/route.js';

// The catalog API routes of the attachments of records (Phase 2 spec §8, §12.2; plan Task 18, route catalog): add a
// file or a link to a record, change one, archive one; and the list the admin's attachments panel reads.
//
// - Writes need `catalog.records.manage` (attachments belong to records, which are global: no branch); they are
//   `store` routes and answer `StoreResponse` (`{id, version}`), never the attachment (S15): the panel reads the list
//   again after each write. A create answers 201. Archive takes the row's `version` in its body (`{version}`).
// - The services (core catalog/attachments) audit once in the handler's transaction (`catalog.attachment.*`), keep
//   `files.access` equal to the attachment's access, move the record's `changed_at`, index it, and publish
//   `catalog.record.changed` as their last statement.
// - `GET catalog/records/:id/attachments` (`catalog.records.read`) is not in the plan's route catalog, which lists the
//   three writes only: the panel needs every live attachment with its `version` and `description` to edit or archive
//   it, and `GET catalog/records/:id` (Task 16's `RecordDetail.attachments`) carries neither. It answers Task 4's
//   `AttachmentListResponse` from `listAttachments` (staff view: public and staff attachments, archived ones left out).

const RECORDS = '/api/v1/catalog/records';
const ATTACHMENTS = '/api/v1/catalog/attachments';
const IdParams = z.strictObject({ id: ulidField });
/** The body of archive: the attachment's version. */
const VersionBody = z.strictObject({ version: versionField });

/**
 * The create body as the route declares it. The route contract takes a strict object at the top (http/route.ts
 * `body_not_strict`), and Task 4's `AttachmentCreateBody` is a union by `kind`: this object names the fields of both
 * kinds (and no other), and its refinement applies the contract itself, so a request is refused with the contract's
 * own issues (`{path: 'url', code: 'invalid_url'}`, a `fileId` sent with a link, ...). The service parses it again.
 */
const CreateRouteBody = z
  .strictObject({
    kind: z.unknown(),
    fileId: z.unknown().optional(),
    url: z.unknown().optional(),
    title: z.unknown(),
    description: z.unknown().optional(),
    access: z.unknown(),
  })
  .superRefine((value, ctx) => {
    const parsed = AttachmentCreateBody.safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
  });

/** A store route's answer: the id and the new version. */
const storeResponse = (id: string, version: number): StoreResponse => ({ id, version });

const attachmentsList = route({
  id: 'catalog.attachments.list',
  method: 'GET',
  path: `${RECORDS}/:id/attachments`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const body: AttachmentListResponse = { items: await listAttachments(rc.db.db, rc.params.id, { publicOnly: false }) };
    return { body };
  },
});

const attachmentsCreate = route({
  id: 'catalog.attachments.create',
  method: 'POST',
  path: `${RECORDS}/:id/attachments`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.attachment.create',
  params: IdParams,
  body: CreateRouteBody,
  handler: async (rc) => {
    // Checked by the refinement above; parsed again for its type (it cannot fail here).
    const view = await createAttachment(rc.tx(), rc.params.id, AttachmentCreateBody.parse(rc.body));
    return { status: 201, body: storeResponse(view.id, view.version) };
  },
});

const attachmentsUpdate = route({
  id: 'catalog.attachments.update',
  method: 'PATCH',
  path: `${ATTACHMENTS}/:id`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.attachment.update',
  params: IdParams,
  body: AttachmentPatchBody,
  handler: async (rc) => {
    const view = await updateAttachment(rc.tx(), rc.params.id, rc.body);
    return { body: storeResponse(view.id, view.version) };
  },
});

const attachmentsArchive = route({
  id: 'catalog.attachments.archive',
  method: 'DELETE',
  path: `${ATTACHMENTS}/:id`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.attachment.archive',
  params: IdParams,
  body: VersionBody,
  handler: async (rc) => {
    const view = await archiveAttachment(rc.tx(), rc.params.id, rc.body.version);
    return { body: storeResponse(view.id, view.version) };
  },
});

export const ATTACHMENTS_ROUTES: RouteDecl[] = [attachmentsList, attachmentsCreate, attachmentsUpdate, attachmentsArchive];
